import { z } from "zod";
import { createFeedbackIssue, FEEDBACK_KINDS, getScreenshot } from "@/lib/feedback";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Public endpoint for the feedback widget: validates the note and files it
 * as a GitHub issue. It is anonymous by design (the widget shows on the
 * landing too), so abuse control lives in lib/feedback: honeypot, per-IP
 * rate limit, labelled issues.
 */

const Schema = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(5).max(4000),
  page: z.string().max(120).optional(),
  screenshotBase64: z.string().max(600_000).optional(),
  component: z
    .object({
      tag: z.string().max(30),
      id: z.string().max(80).nullable(),
      classes: z.array(z.string().max(60)).max(12),
      xpath: z.string().max(300),
      text_content: z.string().max(100).nullable(),
    })
    .optional(),
  pageTitle: z.string().max(120).optional(),
  userAgent: z.string().max(160).optional(),
  viewport: z.object({ width: z.number().int().max(10000), height: z.number().int().max(10000) }).optional(),
  /** honeypot: humans never see this field, bots fill it */
  website: z.string().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "dati non validi: servono tipo, titolo e descrizione" }, { status: 400 });
  }
  // chi compila il campo invisibile e' un bot: si finge successo e basta
  if (parsed.data.website !== undefined && parsed.data.website !== "") {
    return Response.json({ ok: true, number: 0, url: "" });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  try {
    const issue = await createFeedbackIssue(ip, parsed.data, new URL(req.url).origin);
    return Response.json({ ok: true, number: issue.number, url: issue.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /troppi messaggi/.test(message) ? 429 : 502;
    return Response.json({ error: message.slice(0, 200) }, { status });
  }
}

/** the screenshot attached to an issue: public bytes, cacheable forever */
export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const shot = await getScreenshot(id);
  if (!shot) return new Response("not found", { status: 404 });
  return new Response(Buffer.from(shot.data, "base64"), {
    headers: {
      "content-type": shot.contentType,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
