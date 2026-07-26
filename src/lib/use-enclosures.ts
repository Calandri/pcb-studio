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
 * Stato del designer di scocche per un progetto: record dal server, parametri
 * della scocca parametrica, mesh compilate per il canvas. Le sorgenti JSCAD
 * (template parametrico e codice AI) passano tutte dallo stesso worker; i CAD
 * importati vengono riletti dal base64 salvato.
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
  // ultima versione compilata per sorgente: evita ricompilazioni identiche
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
        // sorgente parametrico corrotto: si riparte dai default
      }
    }
    setLoaded(true);
  }, [projectId, boardWidthMm, boardHeightMm]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- compilazione mesh ---------------------------------------------------
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;

    (async () => {
      const next: SceneMesh[] = [];
      const nextErrors: EnclosureError[] = [];

      // la scocca parametrica esiste sempre: finche' non viene salvata vive
      // solo in memoria, ma si vede lo stesso
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

  // ---- azioni ----------------------------------------------------------------

  /** aggiorna i parametri e li salva (debounced) come record parametrico */
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

  /** importa un file CAD: parsing nel browser, poi salvataggio come base64 */
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
        // parsing subito: un file che non si apre non viene nemmeno salvato
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

// riesportati per i consumatori dell'hook (sidebar, canvas)
export { arrayBufferToBase64, base64ToArrayBuffer };
