import { requireProjectAccess } from "@/lib/acl";
import {
  applicaClassi,
  classiDalRame,
  type CambioPista,
  type CambioVia,
} from "@/lib/classi-rame";
import {
  MANUAL_EDITS_PATH,
  parseManualEdits,
  serializeManualEdits,
} from "@/lib/manual-edits";
import { getProject, writeProjectFile } from "@/lib/project-store";

export const runtime = "nodejs";

/**
 * LE CLASSI DEL RAME di un progetto: quali misure usa, e cambiarne una in blocco.
 *
 * Sta qui e non nelle regole di fabbricazione perche' sono due cose diverse e
 * confonderle e' il modo di rovinare una scheda: un minimo dice cosa il
 * fornitore riesce a fare e non tocca il rame, una classe E' il rame e cambiarla
 * lo riscrive. Per questo l'operazione e' esplicita, dice quanti pezzi sposta
 * prima di spostarli, e scrive in manual-edits.json, cioe' dove sta tutto il
 * rame disegnato a mano: da li' la compilazione lo rimette sulla scheda e i
 * controlli lo rimisurano.
 */

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  const fsMap = await getProject(projectId);
  const edits = parseManualEdits(fsMap[MANUAL_EDITS_PATH]);
  return Response.json({ ok: true, classi: classiDalRame(edits.pcb_routes ?? []) });
}

/** una misura credibile: sotto i 20 micron non e' rame, sopra i 10mm non e' una via */
const misura = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;

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

  const via: CambioVia[] = [];
  for (const x of Array.isArray(body.via) ? body.via : []) {
    const c = x as { da?: Record<string, unknown>; a?: Record<string, unknown> };
    const daPad = misura(c.da?.padMm, 0.05, 10);
    const daForo = misura(c.da?.foroMm, 0.02, 10);
    const aPad = misura(c.a?.padMm, 0.05, 10);
    const aForo = misura(c.a?.foroMm, 0.02, 10);
    if (daPad === null || daForo === null || aPad === null || aForo === null) continue;
    /*
     * Il foro non puo' essere piu' largo del pad: sarebbe una via senza rame
     * attorno, cioe' un buco. Meglio rifiutare che disegnare una cosa che non
     * esiste.
     */
    if (aForo >= aPad) {
      return Response.json(
        { error: `il foro ${aForo}mm non ci sta in un pad da ${aPad}mm` },
        { status: 400 },
      );
    }
    via.push({ da: { padMm: daPad, foroMm: daForo }, a: { padMm: aPad, foroMm: aForo } });
  }

  const piste: CambioPista[] = [];
  for (const x of Array.isArray(body.piste) ? body.piste : []) {
    const c = x as Record<string, unknown>;
    const da = misura(c.daMm, 0.02, 20);
    const a = misura(c.aMm, 0.02, 20);
    if (da === null || a === null) continue;
    piste.push({ daMm: da, aMm: a });
  }

  if (via.length === 0 && piste.length === 0) {
    return Response.json({ error: "niente da cambiare" }, { status: 400 });
  }

  const fsMap = await getProject(projectId);
  const edits = parseManualEdits(fsMap[MANUAL_EDITS_PATH]);
  const esito = applicaClassi(edits.pcb_routes ?? [], { via, piste });
  await writeProjectFile(
    projectId,
    MANUAL_EDITS_PATH,
    serializeManualEdits({ ...edits, pcb_routes: esito.routes }),
  );
  return Response.json({
    ok: true,
    viaCambiate: esito.viaCambiate,
    pisteCambiate: esito.pisteCambiate,
    classi: classiDalRame(esito.routes),
  });
}
