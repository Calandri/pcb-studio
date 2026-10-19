"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { compileJscad, latestWins, SupersededError } from "./jscad-client";
import { KIND_COLOR, type MeshData, type SceneMesh } from "./mesh3d";

/**
 * Enclosure designer state for a project: records from the server, parameters
 * of the parametric enclosure, meshes compiled for the canvas. The JSCAD
 * sources (parametric template and AI code) all go through the same worker;
 * imported CAD files are re-read from the saved base64, once per version.
 */

export const PARAMETRIC_NAME = "scocca";

export interface EnclosureError {
  name: string;
  message: string;
}

/** the error row of a save that did not go through */
const SAVE_ERROR = "salvataggio";
/** how long the parameters must stay still before the scocca is recompiled */
const PARAMETRIC_DEBOUNCE_MS = 120;

/*
 * One lane for the parametric enclosure: while the slider moves, only the last
 * value is compiled and only its result reaches the scene (see latestWins).
 */
const compileParametric = latestWins(compileJscad);

export function useEnclosures(
  projectId: string,
  boardWidthMm: number | null,
  boardHeightMm: number | null,
) {
  const [records, setRecords] = useState<EnclosureRecord[]>([]);
  const [params, setParamsState] = useState<EnclosureParams>(() =>
    defaultEnclosureParams(boardWidthMm, boardHeightMm),
  );
  /*
   * The parametric enclosure and the saved records are compiled apart. They
   * were one loop, so every slider tick re-parsed every imported CAD file and
   * recompiled every AI enclosure, none of which the slider touches.
   */
  const [parametric, setParametric] = useState<MeshData[] | null>(null);
  const [parametricError, setParametricError] = useState<EnclosureError | null>(null);
  const [recordMeshes, setRecordMeshes] = useState<SceneMesh[]>([]);
  const [recordErrors, setRecordErrors] = useState<EnclosureError[]>([]);
  const [importErrors, setImportErrors] = useState<EnclosureError[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const paramsRef = useRef(params);
  const boardRef = useRef({ w: boardWidthMm, h: boardHeightMm });
  /*
   * Parameters changed here and not yet confirmed saved, with the project they
   * belong to. While this is set, a copy of the parameters coming from the
   * server is older than what is under the hand and is not applied.
   */
  const unsaved = useRef<{ projectId: string; params: EnclosureParams } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** compiled meshes per record: reused while kind, file and source are the same */
  const meshCache = useRef(
    new Map<string, { kind: string; fileName: string | null; source: string; meshes: MeshData[] }>(),
  );

  useEffect(() => {
    boardRef.current = { w: boardWidthMm, h: boardHeightMm };
  }, [boardWidthMm, boardHeightMm]);

  /*
   * Loaded once per project. It used to depend on the board size too, so it ran
   * again when the circuit arrived (and at every recompile that changed the
   * outline) and put the saved parameters back over the ones being edited.
   */
  const load = useCallback(async () => {
    const res = await fetch(`/api/enclosure?projectId=${projectId}`).catch(() => null);
    const d = res?.ok ? await res.json().catch(() => null) : null;
    if (!d) {
      // a failed reload keeps what is on screen instead of emptying it
      setLoaded(true);
      return;
    }
    const list = (d.enclosures ?? []) as EnclosureRecord[];
    setRecords(list);
    if (unsaved.current?.projectId !== projectId) {
      const savedParams = list.find((r) => r.kind === "parametric");
      let next = defaultEnclosureParams(boardRef.current.w, boardRef.current.h);
      if (savedParams) {
        try {
          next = { ...next, ...(JSON.parse(savedParams.source) as Partial<EnclosureParams>) };
        } catch {
          // corrupt parametric source: fall back to the defaults
        }
      }
      paramsRef.current = next;
      setParamsState(next);
    }
    setLoaded(true);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** sends the unsaved parameters now; `keepalive` lets the request outlive the page */
  const saveNow = useCallback((keepalive: boolean) => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const job = unsaved.current;
    if (!job) return;
    void fetch("/api/enclosure", {
      method: "POST",
      keepalive,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: job.projectId,
        name: PARAMETRIC_NAME,
        kind: "parametric",
        source: JSON.stringify(job.params),
        visible: true,
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const d = await res.json().catch(() => null);
          throw new Error(d?.error ?? `HTTP ${res.status}`);
        }
        // saved: unless the hand moved again in the meantime, nothing is left
        if (unsaved.current === job) unsaved.current = null;
        setSaveError(null);
      })
      .catch((err) => {
        setSaveError(
          `parametri della scocca non salvati (${
            err instanceof Error ? err.message : String(err)
          }): riprovo alla prossima modifica`,
        );
      });
  }, []);

  /*
   * A change still inside the debounce went nowhere when the tab was closed or
   * the page changed: the timer died with the page. Now it leaves on pagehide,
   * on unmount and when the project changes, as a keepalive request.
   */
  useEffect(() => {
    const onHide = () => saveNow(true);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [saveNow]);
  useEffect(() => () => saveNow(true), [projectId, saveNow]);

  // ---- mesh compilation ---------------------------------------------------

  // the parametric enclosure always exists: until it is saved it lives only in
  // memory, but it is visible anyway
  useEffect(() => {
    if (!loaded || !boardWidthMm || !boardHeightMm) return;
    let cancelled = false;
    const code = parametricEnclosureCode(boardWidthMm, boardHeightMm, params);
    const timer = setTimeout(() => {
      compileParametric(code).then(
        (compiled) => {
          if (cancelled) return;
          setParametric(compiled);
          setParametricError(null);
        },
        (err) => {
          if (cancelled || err instanceof SupersededError) return;
          setParametricError({
            name: PARAMETRIC_NAME,
            message: err instanceof Error ? err.message : String(err),
          });
        },
      );
    }, PARAMETRIC_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loaded, params, boardWidthMm, boardHeightMm]);

  // saved enclosures and imported models: only when the records change
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;

    (async () => {
      const next: SceneMesh[] = [];
      const nextErrors: EnclosureError[] = [];
      const cache = meshCache.current;
      const live = new Set<string>();

      for (const record of records) {
        if (record.kind === "parametric") continue;
        live.add(record.name);
        try {
          const hit = cache.get(record.name);
          let meshes =
            hit &&
            hit.kind === record.kind &&
            hit.fileName === record.fileName &&
            hit.source === record.source
              ? hit.meshes
              : null;
          if (!meshes) {
            if (record.kind === "jscad") {
              meshes = await compileJscad(record.source);
            } else {
              const { parseCadFile: parse, base64ToArrayBuffer: decode } = await import(
                "./cad-import"
              );
              meshes = [await parse(record.fileName ?? record.name, decode(record.source))];
            }
            if (cancelled) return;
            cache.set(record.name, {
              kind: record.kind,
              fileName: record.fileName,
              source: record.source,
              meshes,
            });
          }
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
      for (const name of [...cache.keys()]) if (!live.has(name)) cache.delete(name);
      setRecordMeshes(next);
      setRecordErrors(nextErrors);
    })();

    return () => {
      cancelled = true;
    };
  }, [loaded, records]);

  const meshes = useMemo<SceneMesh[]>(() => {
    if (!parametric || !boardWidthMm || !boardHeightMm) return recordMeshes;
    const record = records.find((r) => r.kind === "parametric" && r.name === PARAMETRIC_NAME);
    return [
      {
        id: PARAMETRIC_NAME,
        name: "Scocca parametrica",
        kind: "parametric",
        meshes: parametric,
        color: params.color,
        visible: record?.visible ?? true,
        transform: record?.transform ?? { x: 0, y: 0, z: 0, rotZ: 0 },
      },
      ...recordMeshes,
    ];
  }, [parametric, boardWidthMm, boardHeightMm, records, params.color, recordMeshes]);

  const errors = useMemo<EnclosureError[]>(
    () => [
      ...(parametricError ? [parametricError] : []),
      ...recordErrors,
      ...importErrors,
      ...(saveError ? [{ name: SAVE_ERROR, message: saveError }] : []),
    ],
    [parametricError, recordErrors, importErrors, saveError],
  );

  // ---- actions ----------------------------------------------------------------

  /** updates the parameters and saves them (debounced) as a parametric record */
  const setParams = useCallback(
    (patch: Partial<EnclosureParams>) => {
      const next = { ...paramsRef.current, ...patch };
      paramsRef.current = next;
      setParamsState(next);
      unsaved.current = { projectId, params: next };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveNow(false), 600);
    },
    [projectId, saveNow],
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
      // a refused change puts back what the server really holds
      await fetch("/api/enclosure", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, name, ...patch }),
      })
        .then((res) => (res.ok ? undefined : load()))
        .catch(() => void load());
    },
    [projectId, load],
  );

  const remove = useCallback(
    async (name: string) => {
      setRecords((list) => list.filter((r) => r.name !== name));
      await fetch(
        `/api/enclosure?projectId=${projectId}&name=${encodeURIComponent(name)}`,
        { method: "DELETE" },
      )
        .then((res) => (res.ok ? undefined : load()))
        .catch(() => void load());
    },
    [projectId, load],
  );

  /** imports a CAD file: parse in the browser, then save as base64 */
  const importFile = useCallback(
    async (file: File) => {
      const ext = cadExtension(file.name);
      if (!ext) {
        setImportErrors((e) => [...e, { name: file.name, message: "formato non supportato" }]);
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
        setImportErrors((e) => [
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
    setImportErrors((list) => list.filter((e) => e.name !== name));
    setRecordErrors((list) => list.filter((e) => e.name !== name));
    setParametricError((e) => (e?.name === name ? null : e));
    if (name === SAVE_ERROR) setSaveError(null);
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
