import { accessoDaRichiesta, requireProjectAccess } from "@/lib/acl";
import { commitManualEdits, rilasciaPezzi } from "@/lib/manual-edits-store";
import {
  applyEditEvents,
  applyPlacementPatches,
  applyRoutePatch,
  countManualEdits,
  EDIT_LIMITS,
  emptyManualEdits,
  findOrphanEdits,
  MANUAL_EDITS_PATH,
  normalizeRotation,
  parseManualEdits,
  parseNames,
  parsePlacementPatches,
  releaseManualEdits,
  type EditEvent,
  type ManualEdits,
} from "@/lib/manual-edits";
import { mergeManualRoutes, parseManualRoutes } from "@/lib/manual-routes";
import { parseLength } from "@/lib/pcb-route-model";
import {
  getCompileCache,
  getCompileMeta,
  getProject,
  projectExists,
  type CompileCache,
} from "@/lib/project-store";

export const runtime = "nodejs";

/**
 * The geometric layer of the human being: where a component sits and how
 * a trace runs. It does not recompile — saving and recompiling are two
 * separate gestures, so you can move ten components and pay for one compile.
 *
 * Every action is a read-modify-write of manual-edits.json, and every one goes
 * through updateProjectFile: the write lands only on the version that was
 * read, and on a conflict the change is recomputed on the fresh file. Two
 * quick saves (a drag during a route save, a pin while a rearrange writes its
 * positions) used to read the same file and the second erased the first.
 */

/** what one save of the editor may carry: it sends a handful at a time */
const POST_LIMITS = { maxRoutes: 200, maxPoints: 2000, maxNames: 400 } as const;

function payload(edits: ManualEdits, cache?: CompileCache | null, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    edits,
    counts: countManualEdits(edits),
    /*
     * The edits that point at nothing on the last compiled board: renamed
     * or removed parts, connections that no longer exist. Measured against
     * the cache, so right after a structural change it can list a part that
     * the next compile will bring back.
     */
    ...(cache?.circuitJson ? { orphans: findOrphanEdits(cache.circuitJson, edits) } : {}),
    ...extra,
  };
}

/** the conflict-safe write of manual-edits.json: see lib/manual-edits-store.ts */
const commit = commitManualEdits;

const failure = (err: unknown) =>
  Response.json(
    { error: err instanceof Error ? err.message : String(err) },
    { status: 409 },
  );

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  const fsMap = await getProject(projectId);
  return Response.json(payload(parseManualEdits(fsMap[MANUAL_EDITS_PATH])));
}

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "corpo non valido" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "corpo non valido" }, { status: 400 });
  }

  const projectId =
    typeof body.projectId === "string" && body.projectId.length <= 120
      ? body.projectId
      : "default";
  const names = Array.isArray(body.names)
    ? body.names
        .filter((n): n is string => typeof n === "string" && n.length > 0 && n.length <= 120)
        .slice(0, POST_LIMITS.maxNames)
    : null;

  /*
   * Who may write. The browser session, for everything, as before. A personal
   * token (scripts, MCP: Authorization: Bearer pcbs_...) ONLY to let go of the
   * hand-held positions of the parts it NAMES: on sbb-dl-principale an old J1
   * saved by hand kept overriding the file and only the browser could release
   * it (2026-11-09). Same access rule as the session (edit rights on the
   * project). No "release everything", no pin, no move, no write.
   */
  const sessione = await requireProjectAccess(projectId, "edit");
  if (!sessione.ok) {
    const conToken = /^Bearer\s+\S/i.test(req.headers.get("authorization") ?? "");
    const soloRilascio = body.action === "release" && names !== null && names.length > 0;
    // an existing project only: the access check must not create one
    if (!conToken || !soloRilascio || !(await projectExists(projectId)) || !(await accessoDaRichiesta(req, projectId, "edit"))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
  }

  /*
   * A part dragged in Sposta: where it stays, by name, absolute (see
   * PlacementPatch). Nothing here needs the board itself, only WHICH board is
   * saved (for board_base): the board is megabytes, and reading it on every
   * drop is what made a move on tm-4l-r3 take seconds to save (2026-11-09).
   * The answer is small too: what was written and what it replaced, for undo,
   * not the whole file with its 831 hand-drawn traces.
   */
  if (body.action === "place") {
    const t0 = Date.now();
    const patches = parsePlacementPatches(body.placements, EDIT_LIMITS.maxEvents);
    // an undo back to where the code puts a part: its hand position goes
    const remove = parseNames(body.remove, EDIT_LIMITS.maxEvents);
    if (patches.length === 0 && remove.length === 0) {
      return Response.json({ error: "nessuna posizione valida da salvare" }, { status: 400 });
    }
    try {
      const meta = await getCompileMeta(projectId);
      let before: ReturnType<typeof applyPlacementPatches>["before"] = [];
      const { edits } = await commit(projectId, meta, (current) => {
        // may run again on a conflict: `before` is the one of the run that wrote
        const r = applyPlacementPatches(current, patches, remove);
        before = r.before;
        return r.edits;
      });
      const names = new Set(patches.map((p) => p.name));
      // in the function log: whether a page saves this way, and how long it takes
      console.log(`[manual-edits ${projectId}] place ${patches.length} pezzi, tolti ${remove.length}: ${Date.now() - t0} ms`);
      return Response.json({
        ok: true,
        placements: edits.pcb_placements.filter((p) => names.has(p.selector)),
        before,
        counts: countManualEdits(edits),
      });
    } catch (err) {
      return failure(err);
    }
  }

  /*
   * Hand-drawn traces, added and taken away by their key: the same small
   * write as a dragged part. "Applica" in Instrada used to send them with the
   * whole file back (326 KB and 821 traces on tm-4l-r3) and read the board on
   * the way. The answer carries what was replaced, for undo.
   */
  if (body.action === "routes") {
    const t0 = Date.now();
    const add = parseManualRoutes(body.add, POST_LIMITS);
    const removeKeys = Array.isArray(body.remove)
      ? body.remove.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 400).slice(0, POST_LIMITS.maxRoutes)
      : [];
    if (add.length === 0 && removeKeys.length === 0) {
      return Response.json({ error: "nessuna pista valida da salvare" }, { status: 400 });
    }
    try {
      const meta = await getCompileMeta(projectId);
      let replaced: ReturnType<typeof applyRoutePatch>["replaced"] = [];
      let added: ReturnType<typeof applyRoutePatch>["added"] = [];
      const { edits } = await commit(projectId, meta, (current) => {
        const r = applyRoutePatch(current, add, removeKeys);
        replaced = r.replaced;
        added = r.added;
        return r.edits;
      });
      console.log(`[manual-edits ${projectId}] routes +${add.length} -${removeKeys.length}: ${Date.now() - t0} ms`);
      return Response.json({ ok: true, added, replaced, counts: countManualEdits(edits) });
    } catch (err) {
      return failure(err);
    }
  }

  /*
   * The compiled board: needed to translate viewer ids into names, to read
   * positions for "pin", to tell which board the edits were made on, and to
   * list the edits that point at nothing.
   */
  const cache = await getCompileCache(projectId).catch(() => null);

  try {
    // release: a component goes back to automatic placement
    if (body.action === "release") {
      const scope =
        body.scope === "schematic" || body.scope === "pcb" || body.scope === "traces"
          ? body.scope
          : "all";
      /*
       * name = one component, null = everything, names = exactly those. Before
       * this list existed, "release the selected" with 2+ parts passed null and
       * quietly released every pinned component on the board.
       */
      if (names && names.length > 0) {
        const { edits } = await rilasciaPezzi(projectId, cache, names, scope);
        return Response.json(payload(edits, cache));
      }
      const name = typeof body.name === "string" && body.name ? body.name : null;
      const { edits } = await commit(projectId, cache, (current) =>
        releaseManualEdits(current, scope, name),
      );
      return Response.json(payload(edits, cache));
    }

    /*
     * Pins the components where they are now, so no automatic action moves
     * them anymore.
     *
     * The value to write is `display_offset`, not the center: display_offset IS
     * the requested origin of the component, while the center includes the
     * footprint offset (for a QFP the pads are not centered on the origin).
     * Writing the center where the origin goes shifts the part by that offset —
     * every time you save, and on a board that can be as much as seventeen
     * millimeters.
     */
    if (body.action === "pin") {
      if (!cache?.circuitJson) {
        return Response.json(
          { error: "non c'e' una scheda compilata da cui leggere le posizioni" },
          { status: 404 },
        );
      }
      const soli = names && names.length > 0 ? new Set(names) : null;
      const elements = cache.circuitJson as Array<Record<string, unknown>>;
      const nomeDi = new Map<string, string>();
      for (const el of elements) {
        if (el.type === "source_component" && el.source_component_id) {
          nomeDi.set(String(el.source_component_id), String(el.name ?? ""));
        }
      }
      const posizioni: Array<{ nome: string; x: number; y: number; rotazione?: number }> = [];
      for (const el of elements) {
        if (el.type !== "pcb_component") continue;
        const nome = nomeDi.get(String(el.source_component_id ?? ""));
        if (!nome || (soli && !soli.has(nome))) continue;
        // the requested origin, relative to the parent group like pcbX itself
        const x = parseLength(el.display_offset_x);
        const y = parseLength(el.display_offset_y);
        if (x === null || y === null) continue;
        /*
         * Zero is a rotation like any other: with `if (rotazione)` a part turned
         * back straight kept the old 90° in the placements, and at the next
         * compile it turned again by itself.
         */
        const rotazione = normalizeRotation(el.rotation) ?? undefined;
        posizioni.push({ nome, x, y, ...(rotazione !== undefined ? { rotazione } : {}) });
      }
      const { edits } = await commit(projectId, cache, (current) => {
        const pcb = current.pcb_placements.map((p) => ({ ...p }));
        for (const pos of posizioni) {
          const gia = pcb.find((p) => p.selector === pos.nome);
          if (gia) {
            gia.center = { x: pos.x, y: pos.y };
            if (pos.rotazione !== undefined) gia.rotation = pos.rotazione;
            /*
             * Pinned means held by a person: the `auto` mark of the placer must
             * go, otherwise the next "rearrange" moves the part it was asked
             * to leave alone.
             */
            delete gia.auto;
          } else {
            pcb.push({
              selector: pos.nome,
              center: { x: pos.x, y: pos.y },
              ...(pos.rotazione !== undefined ? { rotation: pos.rotazione } : {}),
            });
          }
        }
        return { ...current, pcb_placements: pcb };
      });
      return Response.json(payload(edits, cache, { fissati: posizioni.length }));
    }

    // full replacement: this is how the editor restores an undone state
    if (body.action === "set") {
      const raw = typeof body.edits === "string" ? body.edits : JSON.stringify(body.edits ?? {});
      if (raw.length > 20_000_000) {
        return Response.json({ error: "modifiche troppo grandi" }, { status: 413 });
      }
      const wanted = parseManualEdits(raw);
      const { edits } = await commit(projectId, cache, () => wanted);
      return Response.json(payload(edits, cache));
    }

    if (Array.isArray(body.events) && body.events.length > EDIT_LIMITS.maxEvents) {
      return Response.json(
        { error: `troppi spostamenti in un salvataggio (massimo ${EDIT_LIMITS.maxEvents})` },
        { status: 400 },
      );
    }
    if (Array.isArray(body.routes) && body.routes.length > POST_LIMITS.maxRoutes) {
      return Response.json(
        { error: `troppe piste in un salvataggio (massimo ${POST_LIMITS.maxRoutes})` },
        { status: 400 },
      );
    }
    const events = Array.isArray(body.events)
      ? (body.events.filter((e) => typeof e === "object" && e !== null) as EditEvent[])
      : [];
    const routes = parseManualRoutes(body.routes, POST_LIMITS);
    /*
     * A route that does not pass the checks (a point at NaN, an unknown
     * layer, a single point) is not saved, and the answer says how many: a
     * trace that silently does not appear is worse than a refusal.
     */
    const rejectedRoutes = Array.isArray(body.routes) ? body.routes.length - routes.length : 0;
    if (events.length === 0 && routes.length === 0) {
      const fsMap = await getProject(projectId);
      return Response.json(
        payload(parseManualEdits(fsMap[MANUAL_EDITS_PATH]), cache, { rejectedRoutes }),
      );
    }

    /*
     * Hand-drawn traces do not need the compiled circuit to be saved: they
     * already carry the name of the connection they implement. They are written
     * right away, so they work even when there is no cache.
     *
     * Replaced by their KEY, the two pads they join: redrawing between the
     * same two pads replaces the previous path, a second branch from one of
     * them is added next to the first.
     */
    if (events.length === 0) {
      const { edits } = await commit(projectId, cache, (current) => ({
        ...current,
        pcb_routes: mergeManualRoutes(current.pcb_routes, routes),
      }));
      return Response.json(payload(edits, cache, { rejectedRoutes }));
    }

    /*
     * Viewer events speak in ids (pcb_component_id, pcb_port_id) that change at
     * every compile: they must be translated into names while the circuit that
     * generated them is still the one in cache. Without a cache nothing can be
     * translated, and saving coordinates referring to an unknown circuit would
     * be worse than refusing.
     */
    if (!cache?.circuitJson) {
      return Response.json(
        { error: "compila il progetto prima di spostare i componenti" },
        { status: 409 },
      );
    }
    // in the function log: a page still saving moves the old way (opened before the deploy)
    console.log(`[manual-edits ${projectId}] events ${events.length} (vecchia via), piste ${routes.length}`);
    const main = (await getProject(projectId))["main.tsx"] ?? "";
    const { edits } = await commit(projectId, cache, (current) => {
      const moved = applyEditEvents({
        circuitJson: cache.circuitJson as unknown[],
        main,
        edits: current,
        events,
      });
      return { ...moved, pcb_routes: mergeManualRoutes(moved.pcb_routes, routes) };
    });
    return Response.json(payload(edits, cache, { rejectedRoutes }));
  } catch (err) {
    return failure(err);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const cache = await getCompileCache(projectId).catch(() => null);
    const { edits } = await commit(projectId, cache, () => emptyManualEdits());
    return Response.json(payload(edits, cache));
  } catch (err) {
    return failure(err);
  }
}
