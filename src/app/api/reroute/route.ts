export const runtime = "nodejs";

/**
 * Automatic routing and placement are gone (Niccolo', 2026-11-09: "il routing
 * lo farai sempre tu, togli ogni AUTO"). This endpoint used to close the open
 * connections with the router ("mancanti"), redo all the copper ("tutto"),
 * rearrange the parts ("posiziona") or lay them out by sections ("sezioni").
 * None of that may happen on its own any more: parts are moved by hand in the
 * viewer and copper is drawn by hand. It answers with the reason instead of
 * disappearing, so an old tab or a script gets a sentence and not a 404.
 */
export async function POST(): Promise<Response> {
  return Response.json(
    {
      error:
        "instradamento e piazzamento automatici rimossi: i pezzi si spostano a mano (Sposta, poi Applica) e le piste si disegnano a mano",
    },
    { status: 410 },
  );
}
