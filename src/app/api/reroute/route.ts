import { requireProjectAccess } from "@/lib/acl";
import { withLibrary } from "@/lib/agent-tools";
import { compileGeometryOnly, compileProject, readBlocks, summarizeCircuit } from "@/lib/compile";
import { getAgentKeys } from "@/lib/llm-keys";
import { listUserOrganizations } from "@/lib/org-store";
import { currentViewer } from "@/lib/acl";
import { pianoDiSezioni } from "@/lib/sezioni";
import { resolveDesignRules } from "@/lib/design-rules";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { routeBoard } from "@/lib/autoroute";
import {
  applyManualEditsToFsMap,
  boardFreshness,
  MANUAL_EDITS_PATH,
  mergeAutoPlacements,
  parseManualEdits,
  readAttr,
  scanJsxTags,
  withoutManualEdits,
  type ManualPlacement,
} from "@/lib/manual-edits";
import {
  filesHash,
  getCompileCache,
  getProject,
  saveCompileCache,
  savePreviewCircuit,
  updateProjectFile,
} from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * Reroutes, and only that: components do not move in either
 * mode.
 *
 * - "mancanti": keeps all the existing copper and closes only the
 *   open connections. The loop works by zones around the problems and keeps
 *   a redone zone only if the score improves, so good traces are
 *   not touched. Seconds or little more.
 * - "tutto": throws away the copper and redoes it from scratch, but the
 *   PLACEMENT stays as it is. Needed when the board has been arranged by hand
 *   and you want fresh copper on a settled layout.
 * - "posiziona": the only way to make the components move. It is asked for,
 *   it does not happen.
 *
 * In both cases hand-drawn traces and user-pinned
 * components are protected by the compiler, which applies them last.
 *
 * The answer is an event stream, not a bare result: a reroute takes minutes,
 * and watching the copper form (the page refreshes the preview every few
 * seconds via savePreviewCircuit) is how you know what is happening —
 * the same contract as /api/compile: "passo" events, then "fine".
 */
/** the component names declared in the sources */
function elencoComponenti(main: string): string[] {
  const out: string[] = [];
  for (const tag of scanJsxTags(main)) {
    if (tag.inAttribute) continue;
    const nome = readAttr(main.slice(tag.attrsStart, tag.attrsEnd), "name");
    if (nome) out.push(nome);
  }
  return out;
}

export async function POST(req: Request): Promise<Response> {
  let projectId = "default";
  let mode: "mancanti" | "tutto" | "posiziona" | "sezioni" = "mancanti";
  /** the names to act on: empty = the whole board */
  let soli: string[] = [];
  try {
    const body = (await req.json()) as {
      projectId?: unknown;
      mode?: unknown;
      only?: unknown;
    };
    if (typeof body.projectId === "string" && body.projectId.length <= 120) {
      projectId = body.projectId;
    }
    if (body.mode === "tutto") mode = "tutto";
    if (body.mode === "posiziona") mode = "posiziona";
    if (body.mode === "sezioni") mode = "sezioni";
    if (Array.isArray(body.only)) soli = body.only.map(String).filter(Boolean).slice(0, 400);
  } catch {
    // missing body: the open connections are closed on the default project
  }

  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const files = await getProject(projectId);
  const fsMap = await withLibrary(files);
  const rules = resolveDesignRules(files).rules;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // the client left: work goes on and the cache is saved anyway
          closed = true;
        }
      };

      const startedAt = Date.now();
      const sec = () => Math.round((Date.now() - startedAt) / 1000);
      // the drawing takes shape in stages: the open page polls the preview
      // every few seconds and shows the copper forming
      let lastPreview = 0;
      const preview = (circuitJson: unknown) => {
        const now = Date.now();
        if (now - lastPreview < 3000) return;
        if (!Array.isArray(circuitJson)) return;
        lastPreview = now;
        void savePreviewCircuit(projectId, circuitJson).catch(() => {});
      };

      try {
        if (mode === "tutto" || mode === "posiziona" || mode === "sezioni") {
          /*
           * "tutto" redoes only the copper and does not touch the layout; "posiziona"
           * expressly asks to rearrange the components. The placer never
           * starts on its own: whoever wants it asks for it, and knows the layout
           * will change.
           */
          const tutti = elencoComponenti(fsMap["main.tsx"] ?? "");
          const fermi = soli.length > 0 ? tutti.filter((n) => !soli.includes(n)) : [];

          /*
           * "sezioni": first the model divides the board, then the solver places
           * inside the sections. Two separate steps on purpose — the plan is
           * something a person reads and can disagree with, and it must not be
           * buried inside a compile that takes minutes.
           */
          let zone: Map<string, { minX: number; maxX: number; minY: number; maxY: number }> | undefined;
          if (mode === "sezioni") {
            /*
             * The keys are the ones of whoever is asking: a section plan costs a
             * model call, and it is paid by the person who wants it.
             */
            const chi = await currentViewer();
            const orgs = chi ? await listUserOrganizations(chi.userId).catch(() => []) : [];
            const chiavi = chi
              ? await getAgentKeys(chi.userId, orgs.map((o) => o.id)).catch(() => ({}))
              : {};
            send("passo", { step: "Divido la scheda in sezioni", detail: "chiedo la pianta al modello", progress: 0.05, sec: sec() });
            const geometria = await compileGeometryOnly(applyManualEditsToFsMap(fsMap));
            const blocchi = readBlocks(fsMap["main.tsx"] ?? "");
            if (blocchi.size === 0) {
              send("errore", {
                error:
                  "lo schematico non dichiara blocchi logici (schSectionName): senza sezioni dichiarate non c'e' niente da dividere",
              });
              return;
            }
            const aMano = new Set(
              parseManualEdits(files[MANUAL_EDITS_PATH])
                .pcb_placements.filter((p) => !p.auto)
                .map((p) => p.selector),
            );
            const { piano, zone: perComponente } = await pianoDiSezioni({
              circuitJson: geometria,
              blocchi,
              fermi: aMano,
              keys: chiavi,
            });
            zone = perComponente;
            send("piano", {
              ragionamento: piano.ragionamento,
              provider: piano.provider,
              tentativi: piano.tentativi,
              sezioni: piano.sezioni,
            });
            for (const s of piano.sezioni) {
              send("passo", {
                step: `Sezione ${s.nome}`,
                detail: `${(s.maxX - s.minX).toFixed(1)}x${(s.maxY - s.minY).toFixed(1)}mm in (${s.minX.toFixed(1)}, ${s.minY.toFixed(1)}): ${s.perche}`,
                progress: 0.1,
                sec: sec(),
              });
            }
          }

          const { summary, circuitJson, placements } = await compileProject(fsMap, {
            place: mode === "posiziona" || mode === "sezioni",
            placeLocked: fermi,
            placeZoneOfComponent: zone,
            onProgress: (event) => {
              send("passo", {
                step: event.step,
                detail: event.detail,
                progress: event.progress,
                sec: sec(),
              });
              if (event.circuitJson) preview(event.circuitJson);
            },
          });
          /*
           * The decided layout gets WRITTEN, it does not stay in the cache.
           *
           * Before, the placer's positions were injected into a copy of the
           * sources and thrown away: the board on screen had an arrangement
           * that no file described, so the next compile computed another one
           * and the parts appeared to move on their own. Now they are saved as
           * `auto` placements — kept, but not frozen: another "rearrange" may
           * move them again, whereas a position placed by hand never is.
           */
          let hash = filesHash(fsMap);
          if (placements && placements.length > 0) {
            const auto: ManualPlacement[] = placements.map((p) => ({
              selector: p.name,
              center: p.center,
              auto: true as const,
              ...(p.rotation !== undefined ? { rotation: p.rotation } : {}),
            }));
            // what the board just computed corresponds to: the snapshot plus these positions
            const sullaFoto = mergeAutoPlacements(files[MANUAL_EDITS_PATH] ?? null, auto);
            let scritto: string | null = null;
            try {
              const r = await updateProjectFile(projectId, MANUAL_EDITS_PATH, (current) =>
                mergeAutoPlacements(current, auto),
              );
              scritto = r.content;
            } catch (err) {
              send("passo", {
                step: "Posizioni NON salvate",
                detail: err instanceof Error ? err.message : String(err),
                progress: 0.95,
                sec: sec(),
              });
            }
            /*
             * The cache belongs to the files WITH the positions just written,
             * otherwise the page believes it is stale and recompiles for
             * nothing — but only if nothing else changed in the file while the
             * placer ran. If a person pinned a part or drew a trace meanwhile,
             * this board does not include it: it is filed under the snapshot,
             * and the page rightly says it is out of date.
             */
            if (scritto !== null && scritto === sullaFoto) {
              hash = filesHash({ ...fsMap, [MANUAL_EDITS_PATH]: scritto });
              send("passo", {
                step: "Posizioni salvate",
                detail: `${placements.length} pezzi scritti su ${MANUAL_EDITS_PATH}: la scheda che vedi e' quella che resta`,
                progress: 0.95,
                sec: sec(),
              });
            } else {
              hash = filesHash({ ...fsMap, [MANUAL_EDITS_PATH]: sullaFoto });
              if (scritto !== null) {
                send("passo", {
                  step: "Posizioni salvate, con modifiche a mano arrivate nel frattempo",
                  detail:
                    "mentre la scheda si rifaceva qualcuno ha cambiato le modifiche a mano: sono state tenute, e per vederle sulla scheda va ricompilata",
                  progress: 0.95,
                  sec: sec(),
                });
              }
            }
          }
          await saveCompileCache(
            projectId,
            hash,
            circuitJson,
            summary,
            CHECKS_ENGINE_VERSION,
          ).catch(() => {});
          send("fine", { ok: summary.ok, mode, summary, salvati: placements?.length ?? 0 });
          return;
        }

        const cached = await getCompileCache(projectId).catch(() => null);
        if (!cached?.circuitJson) {
          send("errore", { error: "non c'e' una scheda compilata su cui lavorare" });
          return;
        }
        /*
         * Only on the board of these sources: closing the open connections of
         * a board the files no longer describe is minutes of work for copper
         * nobody will use.
         */
        const fresh = boardFreshness({
          cacheFilesHash: cached.filesHash,
          filesHash: filesHash(fsMap),
          sourcesHash: filesHash(withoutManualEdits(fsMap)),
          edits: parseManualEdits(files[MANUAL_EDITS_PATH]),
        });
        if (!fresh) {
          send("errore", {
            error:
              "la scheda compilata non e' quella dei file attuali: ricompila prima di chiudere i mancanti",
          });
          return;
        }
        send("passo", { step: "Chiudo i mancanti", detail: "si parte", sec: 0 });
        const { circuitJson, report } = await routeBoard(cached.circuitJson as never, {
          rules,
          budgetMs: 240_000,
          // the whole point of this mode: open connections sit in empty
          // areas, and those are exactly the zones a rip-based loop skips
          routeEvenWithoutRip: true,
          onRound: (round) => {
            preview(round.circuitJson);
            send("passo", {
              step: "Chiudo i mancanti",
              detail: `giro ${round.round}: ${round.score.unrouted} aperti, ${round.score.drc} distanze`,
              progress: null,
              sec: sec(),
            });
          },
        });
        const summary = summarizeCircuit(circuitJson as unknown[], files);
        /*
         * Minutes have passed: if a compile replaced the board meanwhile (a
         * different files hash), that board is newer than this result and is
         * not overwritten. The previews of this run do move createdAt, so only
         * the hash can tell.
         */
        const latest = await getCompileCache(projectId).catch(() => null);
        if (!latest || latest.filesHash !== cached.filesHash) {
          send("errore", {
            error:
              "la scheda e' stata ricompilata mentre chiudevo i mancanti: il risultato non e' salvato, rilancia su quella nuova",
          });
          return;
        }
        await saveCompileCache(
          projectId,
          cached.filesHash,
          circuitJson as unknown[],
          summary,
          CHECKS_ENGINE_VERSION,
        ).catch(() => {});
        send("fine", {
          ok: summary.ok,
          mode,
          rounds: report.rounds.length,
          stoppedBecause: report.stoppedBecause,
          aperte: summary.unroutedConnections.length,
          summary,
        });
      } catch (err) {
        send("errore", { error: err instanceof Error ? err.message : String(err) });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // without this a proxy buffers the stream and delivers it all at once
      "x-accel-buffering": "no",
    },
  });
}
