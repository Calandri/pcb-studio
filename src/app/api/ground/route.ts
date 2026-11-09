export const runtime = "nodejs";

/**
 * Automatic plane vias are gone (Niccolo', 2026-11-09: "togli ogni AUTO").
 * This endpoint used to throw away the vias to the planes and lay new ones on
 * its own: vias are drawn by hand like every other piece of copper. It answers
 * with the reason, so an old tab gets a sentence and not a 404.
 */
export async function POST(): Promise<Response> {
  return Response.json(
    { error: "vie al piano automatiche rimosse: le vie si disegnano a mano" },
    { status: 410 },
  );
}
