import { currentViewer, projectAccess, requireProjectAccess } from "@/lib/acl";
import { resolveApiToken } from "@/lib/api-tokens";
import {
  applicaClassi,
  applicaDoveCiSta,
  classiDalRame,
  CLASSI_PATH,
  ostacoliDaCircuito,
  type CambioPista,
  type CambioVia,
  type NomiDelleClassi,
} from "@/lib/classi-rame";
import {
  MANUAL_EDITS_PATH,
  parseManualEdits,
  serializeManualEdits,
} from "@/lib/manual-edits";
import { distanzaMinimaFra, resolveDesignRules } from "@/lib/design-rules";
import { getCompileCache, getProject, writeProjectFile } from "@/lib/project-store";

export const runtime = "nodejs";

/**
 * Il browser manda una sessione, la riga di comando manda un token personale
 * (pcbs_..., lo stesso dell'import e del server MCP). Due porte, una sola
 * implementazione dietro: una classe cambiata da terminale deve essere la
 * stessa cosa di una cambiata dal pannello.
 */
async function chiPuoScrivere(req: Request, projectId: string): Promise<boolean> {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return (await requireProjectAccess(projectId, "edit")).ok;
  const viewer = await resolveApiToken(bearer);
  if (!viewer) return false;
  return (await projectAccess(projectId, viewer)) === "edit";
}

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
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const viewer = bearer ? await resolveApiToken(bearer) : await currentViewer();
  if ((await projectAccess(projectId, viewer)) === "none") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const fsMap = await getProject(projectId);
  const edits = parseManualEdits(fsMap[MANUAL_EDITS_PATH]);
  return Response.json({
    ok: true,
    classi: classiDalRame(edits.pcb_routes ?? [], leggiNomi(fsMap[CLASSI_PATH])),
  });
}

/** i nomi salvati: un file che non blocca niente se e' rotto o non c'e' */
function leggiNomi(raw: string | undefined): NomiDelleClassi {
  if (!raw) return {};
  try {
    const d = JSON.parse(raw) as NomiDelleClassi;
    return typeof d === "object" && d !== null ? d : {};
  } catch {
    return {};
  }
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
  if (!(await chiPuoScrivere(req, projectId))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

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

  if (via.length === 0 && piste.length === 0 && !Array.isArray(body.nomi)) {
    return Response.json({ error: "niente da cambiare" }, { status: 400 });
  }

  /*
   * I NOMI viaggiano con la misura NUOVA: se la via piccola passa da 0.15 a
   * 0.1524 il suo nome deve seguirla, altrimenti dopo il cambio la famiglia si
   * ritrova senza nome e sembra un'altra.
   */
  const nomi: NomiDelleClassi = { via: [], piste: [] };
  for (const x of Array.isArray(body.nomi) ? body.nomi : []) {
    const c = x as Record<string, unknown>;
    const nome = typeof c.nome === "string" ? c.nome.trim().slice(0, 40) : "";
    if (!nome) continue;
    const pad = misura(c.padMm, 0.05, 10);
    const foro = misura(c.foroMm, 0.02, 10);
    const larg = misura(c.larghezzaMm, 0.02, 20);
    if (pad !== null && foro !== null) nomi.via!.push({ padMm: pad, foroMm: foro, nome });
    else if (larg !== null) nomi.piste!.push({ larghezzaMm: larg, nome });
  }

  const fsMap = await getProject(projectId);
  const edits = parseManualEdits(fsMap[MANUAL_EDITS_PATH]);
  /*
   * Allargare un foro dentro un rame gia' instradato non e' gratis: si allarga
   * dove ci sta, misurando contro il rame delle altre reti con le distanze del
   * progetto, e quelle che non ci stanno restano com'erano e si contano. Senza
   * la scheda compilata non c'e' niente contro cui misurare, e allora si
   * applica e basta: e' il caso di un progetto mai compilato, dove il rame non
   * esiste ancora.
   */
  const regole = resolveDesignRules(fsMap).rules;
  const compilato = await getCompileCache(projectId).catch(() => null);
  const esito = compilato?.circuitJson
    ? applicaDoveCiSta(
        edits.pcb_routes ?? [],
        { via, piste },
        ostacoliDaCircuito(compilato.circuitJson as unknown[]),
        {
          padVia: distanzaMinimaFra(regole, "pad", "via"),
          viaVia: distanzaMinimaFra(regole, "via", "via"),
          pistaVia: distanzaMinimaFra(regole, "trace", "via"),
          foroForo: regole.minHoleToHoleMm,
        },
      )
    : applicaClassi(edits.pcb_routes ?? [], { via, piste });
  if (esito.viaCambiate + esito.pisteCambiate > 0) {
    await writeProjectFile(
      projectId,
      MANUAL_EDITS_PATH,
      serializeManualEdits({ ...edits, pcb_routes: esito.routes }),
    );
  }
  if ((nomi.via?.length ?? 0) + (nomi.piste?.length ?? 0) > 0) {
    await writeProjectFile(projectId, CLASSI_PATH, `${JSON.stringify(nomi, null, 2)}\n`);
  }
  return Response.json({
    ok: true,
    viaCambiate: esito.viaCambiate,
    pisteCambiate: esito.pisteCambiate,
    viaLasciate: esito.viaLasciate ?? 0,
    motivi: esito.motivi ?? {},
    classi: classiDalRame(esito.routes, nomi),
  });
}
