/**
 * DUPLICA VIA: a via of the board copied (Cmd+C in Sposta, with the vias
 * chosen) and pasted elsewhere (Cmd+V, or a click), as many times as wanted:
 * the stitching vias of a ground plane, put down by hand.
 *
 * A pasted via is a copy of the one copied: its net, its hole, its ring and
 * its layers. It joins no trace: it is a lone via of its net, which the pour
 * of that net takes in at the next compile. It is saved as an entry of
 * `pcb_vias` with `aggiunta` (ManualViaMove.aggiunta): laid by
 * applyManualRoutes in the compile and in the fast update, undone by Cmd+Z
 * like any gesture, and moved in Sposta like any lone via.
 *
 * BEFORE IT IS LAID it is judged here against the rules of the project, the
 * way a via in hand is judged (giudica, mosse.ts): the distance from the
 * copper of the other nets (traces, vias, pads), from the holes, the
 * keepouts, the cutouts and the edge of the board, and the ring of another
 * via of its own net; and the strip of mask between its ring and the opening
 * of every SMD pad, whatever its net (minViaToPadOpeningMm, as the DRC
 * measures it: a stitching via in or against a pad lets the solder run down
 * the hole). Where it does not fit, it is not laid, and the block says why.
 * The server checks it again when it is saved (verificaRame).
 *
 * Pure, no React, nothing of the server.
 */
import { distanzaViaApertura, type DesignRules } from "../design-rules";
import { aperturaDelPad, apertureAMano, bordoVicino, rameDelPad, type FormaRame } from "../drc";
import { RETE_SCRIVIBILE } from "../ground-stitching-file";
import { ROUTE_LIMITS, round4, type ManualViaMove } from "../manual-routes";
import { bloccoDelGesto } from "./gesto";
import type { BloccoDelGesto, SalvataggioDelGesto, StatoDelGesto } from "./gesto-tipi";
import { leggiModello } from "./modello";
import { EPS_MM, giudica, type Pezzo } from "./mosse";

type El = Record<string, unknown> & { type: string };

/** a via as it is copied: what a pasted one is made of */
export interface ViaCopiata {
  /** the name of its net, as the entry of `pcb_vias` says it (GND, P3V3) */
  net: string;
  /** mm: the ring and the hole */
  corona: number;
  foro: number;
  /** the layers it joins */
  strati: string[];
}

/** a via waiting to be laid: pasted or moved, and not on the saved board yet */
export interface ViaInAttesa {
  net: string;
  x: number;
  y: number;
  corona: number;
  foro: number;
}

/**
 * The via `pcbViaId` of this board, to paste copies of; or why it cannot be
 * copied: it is not there, its net has no name an entry can carry, it does
 * not say its hole.
 */
export function viaDaCopiare(circuitJson: unknown[], regole: DesignRules, pcbViaId: string): ViaCopiata | { rifiuto: string } {
  const modello = leggiModello(circuitJson, regole);
  const quale = modello.viaPerId.get(pcbViaId);
  const via = quale === undefined ? undefined : modello.vie[quale];
  if (!via) return { rifiuto: "questa via non e' sulla scheda: ricarica la scheda" };
  if (!via.nomeRete || !RETE_SCRIVIBILE.test(via.nomeRete)) return { rifiuto: "la via non e' di una rete con un nome: non si copia" };
  const el = (circuitJson as El[]).find((e) => e.type === "pcb_via" && e.pcb_via_id === pcbViaId);
  if (typeof el?.hole_diameter !== "number") return { rifiuto: "la via non dice il diametro del suo foro: non si copia" };
  return { net: via.nomeRete, corona: via.corona, foro: via.foro, strati: [...via.strati] };
}

/**
 * The via `pcbViaId` of this board, to take out; or why it cannot be taken
 * out from here. Only a via the person pasted goes (its entry of `pcb_vias`
 * leaves the file): a via of the files, or one "Cuci la massa" wrote, is in
 * the sources, and whoever writes them takes it out there.
 */
export function viaDaTogliere(
  circuitJson: unknown[],
  regole: DesignRules,
  pcbViaId: string,
): { net: string; x: number; y: number } | { rifiuto: string } {
  const el = (circuitJson as El[]).find((e) => e.type === "pcb_via" && e.pcb_via_id === pcbViaId);
  if (!el || typeof el.x !== "number" || typeof el.y !== "number") return { rifiuto: "questa via non e' sulla scheda: ricarica la scheda" };
  if (el.aggiunta_da === undefined) {
    return { rifiuto: "questa via e' dei file del progetto: da qui si tolgono solo le vie incollate" };
  }
  const modello = leggiModello(circuitJson, regole);
  const quale = modello.viaPerId.get(pcbViaId);
  const via = quale === undefined ? undefined : modello.vie[quale];
  if (!via?.nomeRete) return { rifiuto: "la via non e' di una rete con un nome: non si toglie da qui" };
  return { net: via.nomeRete, x: round4(el.x), y: round4(el.y) };
}

/** a millimetre figure as the bar says it: a comma, three digits at most */
const millimetri = (v: number): string => String(Math.round(v * 1000) / 1000).replace(".", ",");

/**
 * Whether a copy of `via` can be laid at `dove` (mm, kept to 0.0001) on this
 * board, with `inAttesa` the vias pasted or moved and not on it yet. The place
 * it goes to, or the block, named.
 */
export function provaViaNuova(args: {
  circuitJson: unknown[];
  regole: DesignRules;
  via: ViaCopiata;
  dove: { x: number; y: number };
  inAttesa?: readonly ViaInAttesa[];
}): { ok: true; dove: { x: number; y: number } } | { ok: false; blocco: BloccoDelGesto } {
  const { circuitJson, regole, via } = args;
  const no = (motivo: string, alone?: BloccoDelGesto["alone"]) => ({ ok: false as const, blocco: { motivo, ...(alone ? { alone } : {}) } });
  if (!Number.isFinite(args.dove?.x) || !Number.isFinite(args.dove?.y)) return no("il posto non e' un numero");
  const dove = { x: round4(args.dove.x), y: round4(args.dove.y) };
  if (Math.abs(dove.x) > ROUTE_LIMITS.maxCoordMm || Math.abs(dove.y) > ROUTE_LIMITS.maxCoordMm) return no("bloccato: oltre il metro non e' una scheda");
  const modello = leggiModello(circuitJson, regole);
  // the net, read on this board by its name: the board may have changed since the copy
  const rete = modello.vie.find((v) => v.nomeRete === via.net)?.rete ?? modello.piste.find((p) => p.nomeRete === via.net)?.rete ?? null;
  if (rete === null) return no(`bloccato: la rete ${via.net} non e' piu' sulla scheda`);
  const r = via.corona / 2;

  // 1. the copper, the holes, the keepouts and the edge, as a via in hand is judged; it was nowhere before, so it keeps the whole distance
  const lontano = { ax: 1e6, ay: 1e6, bx: 1e6, by: 1e6 };
  const anello: Pezzo = { ax: dove.x, ay: dove.y, bx: dove.x, by: dove.y, mezza: r, strato: null, tipo: "via", rete, foro: via.foro, prima: lontano, nuovo: true };
  const blocco = giudica(modello, [anello], { piste: new Set(), vie: new Set() });
  if (blocco) return { ok: false, blocco: bloccoDelGesto(modello, blocco) };

  // 2. the vias waiting to be laid, which the board does not show yet
  const fraFori = regole.minHoleToHoleMm;
  for (const v of args.inAttesa ?? []) {
    const d = Math.hypot(v.x - dove.x, v.y - dove.y);
    const stessa = v.net === via.net;
    const aria = stessa ? 1e-4 : Math.max(regole.minClearanceMm, regole.targetClearanceMm ?? 0);
    if (d - r - v.corona / 2 < aria - EPS_MM || d - via.foro / 2 - v.foro / 2 < fraFori - EPS_MM) {
      return no(`bloccato dalla via di ${v.net} appena messa`, { x: v.x, y: v.y, raggioMm: v.corona / 2 });
    }
  }

  // 3. the mask between its ring and the opening of every SMD pad, whatever the net, and the paste openings
  const soglia = distanzaViaApertura(regole);
  const nomeDelPad = new Map<string, string>();
  for (const o of modello.ostacoli) if (o.tipo === "pad") nomeDelPad.set(o.id, o.nome);
  let peggio: { gap: number; nome: string; forma: FormaRame } | null = null;
  // the windows drawn by hand in maschera.json: the pads under one open none of their own (see apertureAMano)
  const aMano = apertureAMano(circuitJson as El[]);
  for (const el of circuitJson as El[]) {
    let apertura: { forma: FormaRame; oltre: number } | null = null;
    let id = "";
    if (el.type === "pcb_smtpad") {
      id = String(el.pcb_smtpad_id ?? "");
      apertura = aMano.coperte.has(id) ? null : aperturaDelPad(el);
    } else if (el.type === "pcb_solder_paste") {
      const forma = rameDelPad(el);
      apertura = forma ? { forma, oltre: 0 } : null;
      id = String(el.pcb_smtpad_id ?? "");
    }
    if (!apertura) continue;
    const gap = bordoVicino(apertura.forma, dove.x, dove.y, apertura.oltre).d - r;
    if (gap >= soglia - EPS_MM || (peggio && gap >= peggio.gap)) continue;
    peggio = { gap, nome: `dalla piazzola ${nomeDelPad.get(id) ?? (id || "una piazzola")}`, forma: apertura.forma };
  }
  for (const a of aMano.aperture) {
    const gap = bordoVicino(a.forma, dove.x, dove.y).d - r;
    if (gap >= soglia - EPS_MM || (peggio && gap >= peggio.gap)) continue;
    peggio = { gap, nome: `dall'apertura a mano «${a.nome}»`, forma: a.forma };
  }
  if (peggio) {
    const quanto = peggio.gap <= 0 ? "dentro l'apertura" : `a ${millimetri(peggio.gap)} mm dall'apertura`;
    return no(`bloccato ${peggio.nome}: la corona sarebbe ${quanto} della maschera, servono ${millimetri(soglia)} mm`, {
      x: peggio.forma.x,
      y: peggio.forma.y,
      raggioMm: 0.5,
    });
  }
  return { ok: true, dove };
}

/** what a pasted via asks to be saved: one entry of `pcb_vias`, laid where it was pasted */
export function salvataggioDellaVia(via: ViaCopiata, dove: { x: number; y: number }, gesto: string): SalvataggioDelGesto {
  const voce: ManualViaMove = {
    net: via.net,
    from: { x: dove.x, y: dove.y },
    to: { x: dove.x, y: dove.y },
    holeDiameter: via.foro,
    outerDiameter: via.corona,
    layers: [...via.strati],
    gesto,
    aggiunta: true,
  };
  return { routes: [], vias: [voce], riscritte: [] };
}

/** the pasted via as the viewer draws it until the saved board shows it */
export function statoDellaVia(via: ViaCopiata, dove: { x: number; y: number }): StatoDelGesto {
  return {
    nascosti: { pcbTraceIds: [], pcbViaIds: [] },
    tratti: [],
    vie: [{ x: dove.x, y: dove.y, outerDiameter: via.corona, holeDiameter: via.foro }],
    posizione: { x: dove.x, y: dove.y },
    blocco: null,
    mosso: true,
  };
}

/** the vias of the gestures waiting, as provaViaNuova takes them: where each is going, with its net and its size */
export function vieInAttesa(salvataggi: readonly SalvataggioDelGesto[]): ViaInAttesa[] {
  return salvataggi.flatMap((s) => s.vias.map((v) => ({ net: v.net, x: v.to.x, y: v.to.y, corona: v.outerDiameter, foro: v.holeDiameter })));
}

