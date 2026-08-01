import { requireProjectAccess } from "@/lib/acl";
import {
  applyEditEvents,
  countManualEdits,
  emptyManualEdits,
  MANUAL_EDITS_PATH,
  parseManualEdits,
  releaseManualEdits,
  serializeManualEdits,
  type EditEvent,
  type ManualEdits,
} from "@/lib/manual-edits";
import { parseManualRoutes, type ManualRoute } from "@/lib/manual-routes";
import { getCompileCache, getProject, writeProjectFile } from "@/lib/project-store";

export const runtime = "nodejs";

/**
 * The geometric layer of the human being: where a component sits and how
 * a trace runs. It does not recompile — saving and recompiling are two
 * separate gestures, so you can move ten components and pay for one compile.
 */

function payload(edits: ManualEdits) {
  return { ok: true, edits, counts: countManualEdits(edits) };
}

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

  const projectId =
    typeof body.projectId === "string" && body.projectId.length <= 120
      ? body.projectId
      : "default";
  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const fsMap = await getProject(projectId);
  const current = parseManualEdits(fsMap[MANUAL_EDITS_PATH]);

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
    const names = Array.isArray(body.names)
      ? body.names.map(String).filter(Boolean).slice(0, 400)
      : null;
    if (names && names.length > 0) {
      let next = current;
      for (const n of names) next = releaseManualEdits(next, scope, n);
      await writeProjectFile(projectId, MANUAL_EDITS_PATH, serializeManualEdits(next));
      return Response.json(payload(next));
    }
    const name = typeof body.name === "string" && body.name ? body.name : null;
    const next = releaseManualEdits(current, scope, name);
    await writeProjectFile(projectId, MANUAL_EDITS_PATH, serializeManualEdits(next));
    return Response.json(payload(next));
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
    const cache = await getCompileCache(projectId).catch(() => null);
    if (!cache?.circuitJson) {
      return Response.json(
        { error: "non c'e' una scheda compilata da cui leggere le posizioni" },
        { status: 404 },
      );
    }
    const soli =
      Array.isArray(body.names) && body.names.length > 0
        ? new Set(body.names.map(String))
        : null;
    const elements = cache.circuitJson as Array<Record<string, unknown>>;
    const nomeDi = new Map<string, string>();
    for (const el of elements) {
      if (el.type === "source_component" && el.source_component_id) {
        nomeDi.set(String(el.source_component_id), String(el.name ?? ""));
      }
    }
    const next = {
      ...current,
      pcb_placements: [...current.pcb_placements],
    };
    let fissati = 0;
    for (const el of elements) {
      if (el.type !== "pcb_component") continue;
      const nome = nomeDi.get(String(el.source_component_id ?? ""));
      if (!nome || (soli && !soli.has(nome))) continue;
      const x = el.display_offset_x;
      const y = el.display_offset_y;
      if (typeof x !== "number" || typeof y !== "number") continue;
      /*
       * Zero is a rotation like any other: with `if (rotazione)` a part turned
       * back straight kept the old 90° in the placements, and at the next
       * compile it turned again by itself.
       */
      const rotazione = typeof el.rotation === "number" ? el.rotation : undefined;
      const gia = next.pcb_placements.find((p) => p.selector === nome);
      if (gia) {
        gia.center = { x, y };
        if (rotazione !== undefined) gia.rotation = rotazione;
      } else {
        next.pcb_placements.push({
          selector: nome,
          center: { x, y },
          ...(rotazione !== undefined ? { rotation: rotazione } : {}),
        });
      }
      fissati++;
    }
    await writeProjectFile(projectId, MANUAL_EDITS_PATH, serializeManualEdits(next));
    return Response.json({ ...payload(next), fissati });
  }

  // full replacement: this is how the editor restores an undone state
  if (body.action === "set") {
    const next = parseManualEdits(
      typeof body.edits === "string" ? body.edits : JSON.stringify(body.edits ?? {}),
    );
    await writeProjectFile(projectId, MANUAL_EDITS_PATH, serializeManualEdits(next));
    return Response.json(payload(next));
  }

  const events = Array.isArray(body.events) ? (body.events as EditEvent[]) : [];
  const routes = parseManualRoutes(body.routes);
  if (events.length === 0 && routes.length === 0) return Response.json(payload(current));

  /*
   * Hand-drawn traces do not need the compiled circuit to be saved: they
   * already carry the name of the connection they implement. They are written
   * right away, so they work even when there is no cache.
   */
  if (events.length === 0) {
    const next = {
      ...current,
      pcb_routes: [
        ...current.pcb_routes.filter((r) => !routes.some((n: ManualRoute) => n.connection === r.connection)),
        ...routes,
      ],
    };
    await writeProjectFile(projectId, MANUAL_EDITS_PATH, serializeManualEdits(next));
    return Response.json(payload(next));
  }

  /*
   * Viewer events speak in ids (pcb_component_id, pcb_port_id) that change at
   * every compile: they must be translated into names while the circuit that
   * generated them is still the one in cache. Without a cache nothing can be
   * translated, and saving coordinates referring to an unknown circuit would
   * be worse than refusing.
   */
  const cache = await getCompileCache(projectId).catch(() => null);
  if (!cache?.circuitJson) {
    return Response.json(
      { error: "compila il progetto prima di spostare i componenti" },
      { status: 409 },
    );
  }

  const main = fsMap["main.tsx"] ?? "";
  const moved = applyEditEvents({
    circuitJson: cache.circuitJson,
    main,
    edits: current,
    events,
  });
  const next = {
    ...moved,
    pcb_routes: [
      ...moved.pcb_routes.filter((r) => !routes.some((n: ManualRoute) => n.connection === r.connection)),
      ...routes,
    ],
  };
  await writeProjectFile(projectId, MANUAL_EDITS_PATH, serializeManualEdits(next));
  return Response.json(payload(next));
}

export async function DELETE(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  await writeProjectFile(
    projectId,
    MANUAL_EDITS_PATH,
    serializeManualEdits(emptyManualEdits()),
  );
  return Response.json(payload(emptyManualEdits()));
}
