/**
 * THE VIAS THE PERSON PASTED (ManualViaMove.aggiunta in manual-edits.json),
 * TAKEN OUT OR MOVED BY AN AGENT, on the person's own asking.
 *
 * In the viewer a pasted via is taken out with Canc ("unpaste") and moved by
 * dragging it ("copper"): only the browser session could. An agent working
 * with the owner's personal token could not, and the owner was left to do by
 * hand what it had asked (Niccolo', 2026-11-19: six vias of his under the
 * O-ring of the microphones to take out, eleven to line up). The file stays
 * forbidden to write_file: this is the one narrow way in, and only for:
 *  - taking out pasted vias named by net and place (never a via of the files,
 *    never a correction of one);
 *  - moving pasted vias named by net and place to a new place on the board,
 *    through the very save and checks of a drag in the viewer (leggiRame,
 *    verificaRame: distances to the copper of the board).
 * Nothing else of the file: no part, no trace, no pin, no release.
 *
 * WHO. The browser session with edit rights, as for every edit; with a
 * personal token, only who owns the project (its author, or an owner or admin
 * of its organization: canManageProject), not whoever can edit it.
 *
 * All of one request or nothing: a via not found, a place off the board or a
 * move that breaks a distance writes nothing, and says which. Every write is
 * logged with who, what, and every entry before and after.
 */
import { canManageProject, projectAccess, type Viewer } from "./acl";
import { withLibrary } from "./agent-tools";
import { resolveDesignRules } from "./design-rules";
import { contornoDellaScheda, profondita } from "./flex-zone";
import { boardStanding, commitManualEdits } from "./manual-edits-store";
import { applyCopperPatch, countManualEdits, senzaAssorbite, type ManualEdits } from "./manual-edits";
import { ROUTE_LIMITS, round4, type ManualViaMove } from "./manual-routes";
import { getCompileCache, getCompileMeta, getProject, projectExists } from "./project-store";
import { RETE_SCRIVIBILE } from "./ground-stitching-file";
import { seAncoraQuella } from "./spinta/porte";
import { senzaLaViaIncollata, type ViaTolta } from "./spinta/rame-locale";
import { conLaPartenzaDeiFile, leggiRame, verificaRame, type EsitoDelRame } from "./spinta/verifica";

/** vias in one request, taken out and moved together: two hands of corrections, never the board */
export const MAX_VIE_INCOLLATE = 60;
/** a pasted via is found where the request says it stands within this (mm): the file keeps four decimals */
const STESSO_POSTO_MM = 1e-4;

export interface SpostamentoDiVia {
  net: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface RichiestaVieIncollate {
  togli: ViaTolta[];
  sposta: SpostamentoDiVia[];
}

const posto = (v: unknown): { x: number; y: number } | null => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const q = v as Record<string, unknown>;
  for (const c of [q.x, q.y]) if (typeof c !== "number" || !Number.isFinite(c) || Math.abs(c) > ROUTE_LIMITS.maxCoordMm) return null;
  return { x: round4(q.x as number), y: round4(q.y as number) };
};
const rete = (v: unknown): string | null => (typeof v === "string" && v.length <= 200 && RETE_SCRIVIBILE.test(v) ? v : null);

/**
 * The request, checked: `unpaste` [{net, x, y}] and `movePastedVias`
 * [{net, from: {x, y}, to: {x, y}}], at least one entry, at most
 * MAX_VIE_INCOLLATE, finite coordinates on the scale of a board, a net by its
 * name, no via named twice. A string says what is wrong.
 */
export function leggiRichiestaVieIncollate(body: { unpaste?: unknown; movePastedVias?: unknown }): RichiestaVieIncollate | string {
  const togliRaw = body.unpaste ?? [];
  const spostaRaw = body.movePastedVias ?? [];
  if (!Array.isArray(togliRaw) || !Array.isArray(spostaRaw)) return "unpaste e movePastedVias sono due liste";
  if (togliRaw.length + spostaRaw.length === 0) return "nessuna via da togliere o da spostare";
  if (togliRaw.length + spostaRaw.length > MAX_VIE_INCOLLATE) return `troppe vie in una richiesta (massimo ${MAX_VIE_INCOLLATE})`;
  const togli: ViaTolta[] = [];
  for (const [i, v] of togliRaw.entries()) {
    const q = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
    const net = rete(q.net);
    const dove = posto({ x: q.x, y: q.y });
    if (!net) return `unpaste[${i}]: la rete va scritta col suo nome`;
    if (!dove) return `unpaste[${i}]: x e y sono due numeri in mm`;
    togli.push({ net, ...dove });
  }
  const sposta: SpostamentoDiVia[] = [];
  for (const [i, v] of spostaRaw.entries()) {
    const q = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
    const net = rete(q.net);
    const from = posto(q.from);
    const to = posto(q.to);
    if (!net) return `movePastedVias[${i}]: la rete va scritta col suo nome`;
    if (!from || !to) return `movePastedVias[${i}]: from e to sono {"x": ..., "y": ...} in mm`;
    if (from.x === to.x && from.y === to.y) return `movePastedVias[${i}]: from e to sono lo stesso posto`;
    sposta.push({ net, from, to });
  }
  const chiavi = [...togli.map((v) => `${v.net}@${v.x},${v.y}`), ...sposta.map((v) => `${v.net}@${v.from.x},${v.from.y}`)];
  if (new Set(chiavi).size !== chiavi.length) return "una via e' nominata due volte";
  return { togli, sposta };
}

/** the pasted via of the file standing there, if there is one */
function incollata(edits: ManualEdits, net: string, x: number, y: number): ManualViaMove | undefined {
  return edits.pcb_vias.find((v) => v.aggiunta === true && v.net === net && Math.abs(v.to.x - x) <= STESSO_POSTO_MM && Math.abs(v.to.y - y) <= STESSO_POSTO_MM);
}

/** who may: the session with edit rights, or a personal token of who owns the project */
export async function puoCorreggereVieIncollate(projectId: string, viewer: Viewer | null, conToken: boolean): Promise<boolean> {
  if (!viewer) return false;
  // an existing project only: the check must not create one
  if (!(await projectExists(projectId))) return false;
  if ((await projectAccess(projectId, viewer)) !== "edit") return false;
  return conToken ? canManageProject(projectId, viewer) : true;
}

export type EsitoVieIncollate =
  | { ok: true; tolte: ManualViaMove[]; spostate: Array<{ prima: ManualViaMove; dopo: ManualViaMove }>; counts: ReturnType<typeof countManualEdits>; avviso?: string }
  | { ok: false; status: number; error: string };

/**
 * Takes the pasted vias out and moves them, in one write of manual-edits.json
 * (on a conflict it runs again on the fresh file). `chi` goes in the log.
 */
export async function correggiVieIncollate(projectId: string, chi: string, richiesta: RichiestaVieIncollate): Promise<EsitoVieIncollate> {
  const conSpostamenti = richiesta.sposta.length > 0;
  // a move is checked on the saved board, as a drag in the viewer: without it there is nothing to measure on
  const scheda = conSpostamenti ? await getCompileCache(projectId).catch(() => null) : null;
  if (conSpostamenti && !scheda?.circuitJson) return { ok: false, status: 409, error: "nessuna scheda compilata: compila prima di spostare le vie" };
  const meta = scheda ? await seAncoraQuella(projectId, scheda) : await getCompileMeta(projectId);
  if (conSpostamenti && !meta) return { ok: false, status: 409, error: "la scheda e' stata risalvata mentre leggevo: riprova" };
  if (scheda?.circuitJson) {
    const contorno = contornoDellaScheda(scheda.circuitJson as Array<Record<string, unknown> & { type: string }>);
    const fuori = richiesta.sposta.find((s) => contorno.length >= 3 && profondita(s.to.x, s.to.y, contorno) <= 0);
    if (fuori) return { ok: false, status: 400, error: `la via ${fuori.net} in (${fuori.from.x}, ${fuori.from.y}): il posto nuovo (${fuori.to.x}, ${fuori.to.y}) e' fuori dalla scheda` };
  }
  const regole = conSpostamenti ? resolveDesignRules(await getProject(projectId)).rules : null;
  // a board saved before the base existed gets it before the first hand edit (bookkeeping only, see board-base.ts)
  if (meta && !meta.base) {
    try {
      await boardStanding(projectId, meta, await withLibrary(await getProject(projectId)));
    } catch {
      /* the edit is saved all the same */
    }
  }

  let problema: { status: number; error: string } | null = null;
  let tolte: ManualViaMove[] = [];
  let spostate: Array<{ prima: ManualViaMove; dopo: ManualViaMove }> = [];
  const quando = new Date().toISOString();
  const gesto = `token-${quando.replace(/\D/g, "").slice(0, 17)}`;
  try {
    const { edits, avviso } = await commitManualEdits(projectId, meta, (current) => {
      // may run again on a conflict, on the file somebody else just wrote: everything is found again there
      problema = null;
      tolte = [];
      spostate = [];
      const mancanti = [
        ...richiesta.togli.filter((v) => !incollata(current, v.net, v.x, v.y)).map((v) => `${v.net} in (${v.x}, ${v.y})`),
        ...richiesta.sposta.filter((s) => !incollata(current, s.net, s.from.x, s.from.y)).map((s) => `${s.net} in (${s.from.x}, ${s.from.y})`),
      ];
      if (mancanti.length > 0) {
        problema = { status: 404, error: `nessuna via incollata da te qui (solo le vie incollate si toccano): ${mancanti.slice(0, 10).join("; ")}` };
        return null;
      }
      let next = current;
      for (const v of richiesta.togli) {
        const via = incollata(next, v.net, v.x, v.y)!;
        tolte.push(via);
        next = senzaLaViaIncollata(next, { net: via.net, x: via.to.x, y: via.to.y });
      }
      if (!conSpostamenti || !scheda?.circuitJson || !regole) return next;
      // the moves: the save of a drag in the viewer, from where each via stands now
      const prime = richiesta.sposta.map((s) => incollata(next, s.net, s.from.x, s.from.y)!);
      const letto = leggiRame(
        {
          gesto,
          vias: richiesta.sposta.map((s, i) => ({
            net: s.net,
            from: prime[i].to,
            to: s.to,
            outerDiameter: prime[i].outerDiameter,
            holeDiameter: prime[i].holeDiameter,
            layers: prime[i].layers,
          })),
        },
        { maxRoutes: 0, maxPoints: 0, maxVias: MAX_VIE_INCOLLATE },
        quando,
      );
      if ("errore" in letto) {
        problema = { status: 400, error: letto.errore };
        return null;
      }
      const correnti = senzaAssorbite(next, scheda.circuitJson);
      const daiFile = conLaPartenzaDeiFile(scheda.circuitJson, correnti, letto.rame);
      const esito: EsitoDelRame = verificaRame({ circuitJson: scheda.circuitJson, regole, correnti, rame: daiFile });
      if (!esito.ok) {
        problema = { status: 409, error: `spostamento rifiutato, niente scritto: ${esito.motivo}` };
        return null;
      }
      const fatto = applyCopperPatch(correnti, daiFile);
      spostate = prime.map((prima, i) => ({ prima, dopo: fatto.added.vias.find((v) => v.net === prima.net && v.to.x === letto.rame.vias[i].to.x && v.to.y === letto.rame.vias[i].to.y) ?? prima }));
      return fatto.edits;
    });
    if (problema) return { ok: false, ...(problema as { status: number; error: string }) };
    const breve = (v: ManualViaMove) => `${v.net}(${v.to.x},${v.to.y})`;
    // in the function log: who, what, every entry before and after
    console.log(
      `[manual-edits ${projectId}] vie incollate da ${chi}: tolte ${tolte.length} [${tolte.map(breve).join(" ")}], ` +
        `spostate ${spostate.length} [${spostate.map((s) => `${breve(s.prima)} -> (${s.dopo.to.x},${s.dopo.to.y})`).join(" ")}]`,
    );
    return { ok: true, tolte, spostate, counts: countManualEdits(edits), ...(avviso ? { avviso } : {}) };
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
}
