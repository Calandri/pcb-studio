import { z } from "zod";
import { currentViewer } from "@/lib/acl";
import { getLibraryComponent, updateLibraryComponent } from "@/lib/library-store";

export const runtime = "nodejs";

const UpdateSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  description: z.string().max(2000).optional(),
  datasheetUrl: z.string().url().max(500).nullable().optional(),
  schematicNotes: z.string().max(4000).optional(),
  layoutNotes: z.string().max(4000).optional(),
});

/** component sheet: info, datasheet, notes (the code stays versioned elsewhere) */
export async function GET(req: Request): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const name = new URL(req.url).searchParams.get("name") ?? "";
  const component = await getLibraryComponent(name);
  if (!component) return Response.json({ error: "not found" }, { status: 404 });
  const { code: _code, ...meta } = component;
  void _code; // the sheet does not send the code: the view lives in the renders
  return Response.json({ component: meta });
}

export async function POST(req: Request): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const parsed = UpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid body" }, { status: 400 });
  const { name, ...fields } = parsed.data;
  await updateLibraryComponent(name, fields);
  return Response.json({ ok: true });
}
