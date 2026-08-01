import { requireProjectAccess } from "@/lib/acl";
import {
  deleteEnclosure,
  ENCLOSURE_NAME_RE,
  listEnclosures,
  saveEnclosure,
  updateEnclosure,
  type EnclosureKind,
} from "@/lib/enclosure-store";

export const runtime = "nodejs";
export const maxDuration = 60;

const KINDS: EnclosureKind[] = ["parametric", "jscad", "import"];
const MAX_SOURCE_CHARS = 20 * 1024 * 1024; // base64 of a ~15MB file

/** Project enclosures and 3D modules: list, save, patch, delete. */

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  return Response.json({ enclosures: await listEnclosures(projectId) });
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const projectId = String(body?.projectId ?? "default");
  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const name = String(body?.name ?? "").trim();
  const kind = String(body?.kind ?? "") as EnclosureKind;
  const source = String(body?.source ?? "");
  if (!ENCLOSURE_NAME_RE.test(name)) {
    return Response.json({ error: "nome non valido" }, { status: 400 });
  }
  if (!KINDS.includes(kind)) {
    return Response.json({ error: `kind non valido: ${kind}` }, { status: 400 });
  }
  if (!source || source.length > MAX_SOURCE_CHARS) {
    return Response.json({ error: "sorgente mancante o troppo grande" }, { status: 413 });
  }

  await saveEnclosure(projectId, {
    name,
    kind,
    source,
    fileName: body?.fileName ? String(body.fileName).slice(0, 200) : null,
    transform: sanitizeTransform(body?.transform),
    visible: body?.visible !== false,
  });
  return Response.json({ ok: true });
}

export async function PATCH(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const projectId = String(body?.projectId ?? "default");
  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const name = String(body?.name ?? "").trim();
  if (!name) return Response.json({ error: "nome mancante" }, { status: 400 });
  if (body?.newName && !ENCLOSURE_NAME_RE.test(String(body.newName))) {
    return Response.json({ error: "nuovo nome non valido" }, { status: 400 });
  }

  try {
    await updateEnclosure(projectId, name, {
      newName: body?.newName ? String(body.newName) : undefined,
      visible: typeof body?.visible === "boolean" ? body.visible : undefined,
      transform: body?.transform ? sanitizeTransform(body.transform) : undefined,
    });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 404 },
    );
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "default";
  const name = url.searchParams.get("name") ?? "";
  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  if (!name) return Response.json({ error: "nome mancante" }, { status: 400 });
  await deleteEnclosure(projectId, name);
  return Response.json({ ok: true });
}

function sanitizeTransform(raw: unknown): {
  x: number;
  y: number;
  z: number;
  rotZ: number;
} {
  const t = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(-max, Math.min(max, n)) : 0;
  };
  return { x: num(t.x, 1000), y: num(t.y, 1000), z: num(t.z, 1000), rotZ: num(t.rotZ, 360) };
}
