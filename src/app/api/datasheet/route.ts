import { requireProjectAccess } from "@/lib/acl";
import { extractDatasheetText } from "@/lib/datasheet";
import { listDatasheets, saveDatasheet } from "@/lib/library-store";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  return Response.json({ datasheets: await listDatasheets(projectId) });
}

/** Upload of a PDF datasheet: the extracted text becomes context for the agent. */
export async function POST(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "multipart form with a 'file' field required" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "file too large (max 30MB)" }, { status: 413 });
  }

  try {
    const extracted = await extractDatasheetText(await file.arrayBuffer());
    if (!extracted.text.trim()) {
      return Response.json(
        { error: "no text found in the PDF (scanned image? OCR is not supported yet)" },
        { status: 422 },
      );
    }
    const saved = await saveDatasheet({
      projectId,
      title: file.name.slice(0, 200),
      sourceUrl: null,
      text: extracted.text,
      pages: extracted.pages,
    });
    return Response.json({
      id: saved.id,
      title: file.name,
      pages: extracted.pages,
      chars: extracted.text.length,
      truncated: extracted.truncated,
    });
  } catch (err) {
    return Response.json(
      { error: `PDF parsing failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 422 },
    );
  }
}
