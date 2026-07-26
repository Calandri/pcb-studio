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
import { getCompileCache, getProject, writeProjectFile } from "@/lib/project-store";

export const runtime = "nodejs";

/**
 * Il livello geometrico dell'essere umano: dove sta un componente e come passa
 * una pista. Non ricompila — salvare e ricompilare sono due gesti distinti,
 * cosi' si possono spostare dieci componenti e pagare una sola compilazione.
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

  // sblocco: un componente torna al posizionamento automatico
  if (body.action === "release") {
    const scope =
      body.scope === "schematic" || body.scope === "pcb" || body.scope === "traces"
        ? body.scope
        : "all";
    const name = typeof body.name === "string" && body.name ? body.name : null;
    const next = releaseManualEdits(current, scope, name);
    await writeProjectFile(projectId, MANUAL_EDITS_PATH, serializeManualEdits(next));
    return Response.json(payload(next));
  }

  // sostituzione integrale: e' cosi' che l'editor ripristina uno stato annullato
  if (body.action === "set") {
    const next = parseManualEdits(
      typeof body.edits === "string" ? body.edits : JSON.stringify(body.edits ?? {}),
    );
    await writeProjectFile(projectId, MANUAL_EDITS_PATH, serializeManualEdits(next));
    return Response.json(payload(next));
  }

  const events = Array.isArray(body.events) ? (body.events as EditEvent[]) : [];
  if (events.length === 0) return Response.json(payload(current));

  /*
   * Gli eventi dei viewer parlano di id (pcb_component_id, pcb_port_id) che
   * cambiano a ogni compilazione: vanno tradotti in nomi mentre il circuito
   * che li ha generati e' ancora quello in cache. Senza cache non si puo'
   * tradurre nulla, e salvare coordinate riferite a un circuito ignoto sarebbe
   * peggio che rifiutare.
   */
  const cache = await getCompileCache(projectId).catch(() => null);
  if (!cache?.circuitJson) {
    return Response.json(
      { error: "compila il progetto prima di spostare i componenti" },
      { status: 409 },
    );
  }

  const main = fsMap["main.tsx"] ?? "";
  const next = applyEditEvents({
    circuitJson: cache.circuitJson,
    main,
    edits: current,
    events,
  });
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
