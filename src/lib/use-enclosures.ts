"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  cadExtension,
  parseCadFile,
} from "./cad-import";
import {
  defaultEnclosureParams,
  parametricEnclosureCode,
  type EnclosureParams,
} from "./enclosure-template";
import type { EnclosureRecord } from "./enclosure-store";
import { compileJscad } from "./jscad-client";
import { KIND_COLOR, type SceneMesh } from "./mesh3d";

/**
 * Enclosure designer state for a project: records from the server, parameters
 * of the parametric enclosure, meshes compiled for the canvas. The JSCAD
 * sources (parametric template and AI code) all go through the same worker;
 * imported CAD files are re-read from the saved base64.
 */

export const PARAMETRIC_NAME = "scocca";

export interface EnclosureError {
  name: string;
  message: string;
}

export function useEnclosures(
  projectId: string,
  boardWidthMm: number | null,
  boardHeightMm: number | null,
) {
  const [records, setRecords] = useState<EnclosureRecord[]>([]);
  const [params, setParamsState] = useState<EnclosureParams>(() =>
    defaultEnclosureParams(boardWidthMm, boardHeightMm),
  );
  const [meshes, setMeshes] = useState<SceneMesh[]>([]);
  const [errors, setErrors] = useState<EnclosureError[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // last compiled version per source: avoids identical recompiles
  const compiledFor = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    const d = await fetch(`/api/enclosure?projectId=${projectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const list = (d?.enclosures ?? []) as EnclosureRecord[];
    setRecords(list);
    const parametric = list.find((r) => r.kind === "parametric");
    if (parametric) {
      try {
        setParamsState({
          ...defaultEnclosureParams(boardWidthMm, boardHeightMm),
          ...(JSON.parse(parametric.source) as Partial<EnclosureParams>),
        });
      } catch {
        // corrupt parametric source: fall back to the defaults
      }
    }
    setLoaded(true);
  }, [projectId, boardWidthMm, boardHeightMm]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- mesh compilation ---------------------------------------------------
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;

    (async () => {
      const next: SceneMesh[] = [];
      const nextErrors: EnclosureError[] = [];

      // the parametric enclosure always exists: until it is saved it lives
      // only in memory, but it is visible anyway
      if (boardWidthMm && boardHeightMm) {
        const code = parametricEnclosureCode(boardWidthMm, boardHeightMm, params);
        const key = `${PARAMETRIC_NAME}:${code}`;
        try {
          const compiled = await compileJscad(code);
          if (cancelled) return;
          compiledFor.current.set(PARAMETRIC_NAME, key);
          const record = records.find(
            (r) => r.kind === "parametric" && r.name === PARAMETRIC_NAME,
          );
          next.push({
            id: PARAMETRIC_NAME,
            name: "Scocca parametrica",
            kind: "parametric",
            meshes: compiled,
            color: params.color,
            visible: record?.visible ?? true,
            transform: record?.transform ?? { x: 0, y: 0, z: 0, rotZ: 0 },
          });
        } catch (err) {
          if (!cancelled) {
            nextErrors.push({
              name: PARAMETRIC_NAME,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      for (const record of records) {
        if (record.kind === "parametric") continue;
        try {
          let meshes;
          if (record.kind === "jscad") {
            meshes = await compileJscad(record.source);
          } else {
            const { parseCadFile: parse, base64ToArrayBuffer: decode } = await import(
              "./cad-import"
            );
            meshes = [await parse(record.fileName ?? record.name, decode(record.source))];
          }
          if (cancelled) return;
          next.push({
            id: record.name,
            name: record.name,
            kind: record.kind,
            meshes,
            color: KIND_COLOR[record.kind],
            visible: record.visible,
            transform: record.transform,
          });
        } catch (err) {
          if (!cancelled) {
            nextErrors.push({
              name: record.name,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      if (cancelled) return;
      setMeshes(next);
      setErrors(nextErrors);
    })();

    return () => {
      cancelled = true;
    };
  }, [loaded, records, params, boardWidthMm, boardHeightMm]);

  // ---- actions ----------------------------------------------------------------

  /** updates the parameters and saves them (debounced) as a parametric record */
  const setParams = useCallback(
    (patch: Partial<EnclosureParams>) => {
      setParamsState((current) => {
        const next = { ...current, ...patch };
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          void fetch("/api/enclosure", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              projectId,
              name: PARAMETRIC_NAME,
              kind: "parametric",
              source: JSON.stringify(next),
              visible: true,
            }),
          });
        }, 600);
        return next;
      });
    },
    [projectId],
  );

  const patchRecord = useCallback(
    async (
      name: string,
      patch: { visible?: boolean; transform?: SceneMesh["transform"]; newName?: string },
    ) => {
      setRecords((list) =>
        list.map((r) =>
          r.name === name
            ? {
                ...r,
                visible: patch.visible ?? r.visible,
                transform: patch.transform ?? r.transform,
                name: patch.newName ?? r.name,
              }
            : r,
        ),
      );
      await fetch("/api/enclosure", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, name, ...patch }),
      }).catch(() => void load());
    },
    [projectId, load],
  );

  const remove = useCallback(
    async (name: string) => {
      setRecords((list) => list.filter((r) => r.name !== name));
      await fetch(
        `/api/enclosure?projectId=${projectId}&name=${encodeURIComponent(name)}`,
        { method: "DELETE" },
      ).catch(() => void load());
    },
    [projectId, load],
  );

  /** imports a CAD file: parse in the browser, then save as base64 */
  const importFile = useCallback(
    async (file: File) => {
      const ext = cadExtension(file.name);
      if (!ext) {
        setErrors((e) => [...e, { name: file.name, message: "formato non supportato" }]);
        return;
      }
      setBusy(file.name);
      try {
        const buffer = await file.arrayBuffer();
        // parse right away: a file that cannot be opened is not even saved
        await parseCadFile(file.name, buffer);
        const name = file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "modello";
        const res = await fetch("/api/enclosure", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId,
            name,
            kind: "import",
            fileName: file.name,
            source: arrayBufferToBase64(buffer),
            visible: true,
          }),
        });
        if (!res.ok) throw new Error(`salvataggio fallito (HTTP ${res.status})`);
        await load();
      } catch (err) {
        setErrors((e) => [
          ...e,
          { name: file.name, message: err instanceof Error ? err.message : String(err) },
        ]);
      } finally {
        setBusy(null);
      }
    },
    [projectId, load],
  );

  const dismissError = useCallback((name: string) => {
    setErrors((list) => list.filter((e) => e.name !== name));
  }, []);

  return {
    records,
    params,
    setParams,
    meshes,
    errors,
    dismissError,
    busy,
    loaded,
    patchRecord,
    remove,
    importFile,
    reload: load,
  };
}

export type EnclosuresApi = ReturnType<typeof useEnclosures>;

// re-exported for the hook's consumers (sidebar, canvas)
export { arrayBufferToBase64, base64ToArrayBuffer };
