/**
 * RIGID-FLEX BOARDS (flex.json).
 *
 * The two modem boards of Wildy (tm-4l-q1, tm-4l-r3: four layers, 1.6 mm) are
 * to become one piece each: the rigid board and a flexible tail that leaves an
 * edge, folds by 90 degrees and goes on in the enclosure as an extension of
 * the ground plane, as Antenova asks for its antenna (Niccolo', 2026-11-18).
 * The fab is PCB Basic, which makes rigid-flex boards and assembles them. A
 * board had one stack and that was all: no flexible zone, no bend line, no
 * coverlay, no stiffener, and the Gerber had no mechanical layer.
 *
 * WHAT THE FILES SAY. The outline of the board (`<board outline>` in main.tsx)
 * is the outline of the whole piece, rigid part and tails together: one
 * contour, cut in one pass. flex.json, a project file like maschera.json, says
 * which part of it bends, in BOARD coordinates (mm, centre of the board = 0,0,
 * y up, seen from the top):
 *
 *   { "pila": { "spessoreMm": 0.1, "coverlay": "giallo", "materiali": [ { "tipo": "rame", "nome": "RA copper 18um", "mm": 0.018 }, ... ] },
 *     "zone": [ { "nome": "coda", "strati": ["inner1"],
 *                 "punti": [ { "x": -18.5, "y": -25.75 }, { "x": 18.5, "y": -25.75 },
 *                            { "x": 18.5, "y": -60.75 }, { "x": -18.5, "y": -60.75 } ],
 *                 "finestre": [ { "nome": "antenna LTE", "punti": [ ... ] } ],
 *                 "ritagli": [ { "nome": "asola vite", "punti": [ ... ] } ] } ],
 *     "pieghe": [ { "nome": "ripiega sulla scheda", "da": { "x": -18.5, "y": -28.75 }, "a": { "x": 18.5, "y": -28.75 },
 *                   "raggioMm": 1, "angolo": 180, "verso": "su" } ],
 *     "irrigiditori": [ { "nome": "rinforzo", "lato": "bottom", "materiale": "poliimmide", "spessoreMm": 0.2,
 *                         "punti": [ ... ], "fori": [ { "x": 2, "y": -53, "diametroMm": 2.2 } ] } ],
 *     "coverlay": { "top": [ { "nome": "contatto", "punti": [ ... ] } ], "bottom": [] } }
 *
 * The whole of it is ESEMPIO_FLEX below, which is what the tools show to
 * whoever writes the file. A zone can have WINDOWS (`finestre`: the laminate
 * stays, no layer has copper: the free area an antenna asks for) and CUTOUTS
 * (`ritagli`: holes cut through the tail). A bend goes up to 180 degrees, a
 * tail folded back over the board.
 *
 * WHAT THE BOARD DOES WITH IT.
 *  - The compile and the recheck put it on the board as elements of their own
 *    (conFlessibile; flex-zone.ts reads them back): the board that is exported
 *    is the board that was checked.
 *  - Copper: in a zone only the layers it declares exist. The pours of the
 *    other layers are cut back from the zone when the planes are poured
 *    (ostacoliDelFlessibile), and a trace or a pad of another layer in the
 *    zone is an error (drc.ts, check 10, with the other checks of the zones).
 *    The pours of the declared layers are cut back from the windows and from
 *    the cutouts too.
 *  - A cutout of a zone is also a pcb_cutout of the board, so the outline of
 *    the Gerber (Edge_Cuts) has it: one contour, with its holes.
 *  - A zone can ask its copper as a GRID (`retino`), on the stretch its bends
 *    curve or on the whole zone: PCB Basic wants the ground of a flexible part
 *    hatched. The pours of its layers are cut into it after they are poured
 *    (flex-retino.ts), and stay one piece.
 *  - Mask and silkscreen stop where the zone starts: there is coverlay there.
 *    In the Gerber the zone is one opening of the mask on both faces, and the
 *    silkscreen drawings that enter it are not written (comandiConIlFlessibile).
 *  - The Gerber package gets a mechanical layer (the zones and the bend
 *    lines), the coverlay and the stiffeners per face, and a text for the fab
 *    with the two stacks and the bends (fileDelFlessibile).
 *
 * Without the file nothing changes, the Gerber included, byte for byte.
 *
 * PCB BASIC. What its site says and where, read on 2026-11-18:
 *  - https://www.pcbasic.com/rigid_flex_board.html (the order form): 2 to 32
 *    layers, a flexible part of 1, 2, 4, 6, 8 or 10 layers and 0.08 to 0.4 mm
 *    and more, coverlay yellow, white or black;
 *  - https://www.pcbasic.com/flexible_pcb.html (the order form): stiffeners in
 *    PI (0.05-0.275 mm), FR4 (0.1-1.6), stainless steel (0.1-0.5) and
 *    aluminium (0.2-1.5), "Please make sure to note the area which need to
 *    stiffen in your file";
 *  - https://www.pcbasic.com/pcba-f/rigid_flex_pcb.html: the bend radius by
 *    number of layers (thickness x 6, x 12, x 24), plated holes "at least 0.5mm
 *    away from the bend area" and none "on the flexible part";
 *  - https://www.pcbasic.com/blog/flex_pcb_design.html: "a minimum bend radius
 *    of >= 10x the board thickness", "Do not place vias in curved areas",
 *    coverlay instead of solder mask, stiffeners at the connectors, and "Use
 *    grid ground layer to enhance flexibility and reduce the risk of copper
 *    cracking";
 *  - https://www.pcbasic.com/blog/rigid_flex_pcb_assembly.html: no parts on
 *    the flexible part unless "rigidized with a stiffener and kept outside the
 *    bend zone".
 * None of them says how to declare the flexible zone in the Gerber files: what
 * is written here is the common practice (one outline, a mechanical layer with
 * zones and bend lines, coverlay and stiffener layers, a stack per zone).
 */
import { resolveStackup } from "./design-rules";
import { MAX_APERTURE_RETINO } from "./flex-retino";
import { aperturaDelPad, type FormaRame } from "./drc";
import {
  APERTURA_COVERLAY,
  contieneTutti,
  contornoDellaScheda,
  eDelFlessibile,
  flessibileDellaScheda,
  IRRIGIDITORE,
  latiDi,
  type Lato,
  PIEGA,
  PILA_FLESSIBILE,
  profondita,
  RITAGLIO_DEL_FLESSIBILE,
  siIncrociano,
  ZONA_FLESSIBILE,
  zonaDelPunto,
  type Flessibile,
  type PilaFlessibile,
  type Punto,
  type StratoFlessibile,
  type Retino,
} from "./flex-zone";
import { areaConSegno, capsula, cerchio, rettangoloArrotondato } from "./pour-geometry";
import { zonaSenzaLoStrato } from "./flex-strati";
import { disegnoStampato } from "./silkscreen-clearance";
import { eStratoDiRame, nomeDelloStrato, stratiDiRame } from "./strati-rame";

type El = Record<string, unknown> & { type: string };

export const FLEX_PATH = "flex.json";

/** at most this many flexible zones on a board: a tail or two, a hinge between two rigid parts */
export const MAX_ZONE = 8;
/** at most this many vertices in one polygon: a tail with every corner rounded */
export const MAX_VERTICI_FLEX = 128;
export const MAX_PIEGHE = 16;
export const MAX_IRRIGIDITORI = 16;
/** holes in one stiffener */
export const MAX_FORI = 50;
/** openings of the coverlay, both faces together */
export const MAX_APERTURE_COVERLAY = 100;
/** rows of the stack of the flexible part */
const MAX_MATERIALI = 24;
/** independent flexible layers in one stack (air gap): PCB Basic's form goes to 10 flexible layers, two or three sheets is what a board asks */
export const MAX_STRATI_FLESSIBILI = 4;
/** windows without copper, and cutouts, in one zone */
export const MAX_FINESTRE = 16;
/** the grid of a zone (`retino`): the widest line and the longest step a file may write (mm) */
const RETINO = { larghezzaMin: 0.05, larghezzaMax: 5, passoMax: 20, margineMax: 10 };
/** the square between two lines of a grid is at least this wide, when the project's rules are not there to say (mm) */
const APERTURA_MINIMA_RETINO_MM = 0.1;
/** how far past the stretch a bend curves a grid laid "piega" goes on, when the file does not say (mm) */
export const MARGINE_RETINO_MM = 1;
/** no board is bigger: a coordinate past it is a typo, before the board is even known */
const COORDINATA_MASSIMA_MM = 1000;
/** a polygon smaller than this is a typo, not a zone */
const AREA_MINIMA_MM2 = 0.01;
/** a vertex this far off the board or off its zone is still on it: coordinates are rounded to the micron */
const SLACK_MM = 0.005;
/** the thickness of a flexible part: PCB Basic's order form starts at 0.08 mm and goes "to 0.4 and more" */
const SPESSORE_FLEX = { min: 0.05, max: 1 };
const LATI = ["top", "bottom"] as const;
type Faccia = (typeof LATI)[number];

/** the coverlay PCB Basic offers, in the words of the file and of the fab */
const COVERLAY: Record<string, string> = { giallo: "yellow", bianco: "white", nero: "black", nessuno: "none" };
/** what a row of the flexible stack can be */
const TIPI_DI_MATERIALE: Record<string, string> = { coverlay: "coverlay", adesivo: "adhesive", rame: "copper", poliimmide: "polyimide", altro: "other" };
/** the stiffeners PCB Basic offers, with the thicknesses of its order form (mm) */
const MATERIALI_IRRIGIDITORE: Record<string, { nome: string; min: number; max: number }> = {
  poliimmide: { nome: "polyimide (PI)", min: 0.05, max: 0.275 },
  fr4: { nome: "FR4", min: 0.1, max: 1.6 },
  acciaio: { nome: "stainless steel", min: 0.1, max: 0.5 },
  alluminio: { nome: "aluminium", min: 0.2, max: 1.5 },
};
/**
 * What a table of the file's words has under a word, when the word is one of
 * its own: `"constructor" in tabella` is true of every object, and a coverlay
 * called "constructor" or a stiffener in "toString" passed as a word of the file.
 */
function voce<T>(tabella: Record<string, T>, parola: unknown): T | undefined {
  return typeof parola === "string" && Object.hasOwn(tabella, parola) ? tabella[parola] : undefined;
}

/** a name: one short line of letters, digits and plain punctuation, so it can go in a text for the fab as it is */
const NOME = /^[A-Za-z0-9À-ÿ _.,:+()/%-]{1,60}$/;

/**
 * A COMPLETE flex.json, the one the tools show: the tail of a modem board of
 * Wildy as it is asked today. One copper layer (ground, on inner1) 0.1 mm
 * thick, 37 mm wide, leaving the bottom edge of the board (y = -25.75) and
 * folded back over it by 180 degrees at 1 mm of inner radius, ten times its
 * thickness, its ground a grid where it bends; a window without copper for an
 * antenna, a cutout, a stiffener with a hole, an opening of the coverlay. The
 * tests read it back through the same check a written file goes through.
 */
export const ESEMPIO_FLEX = {
  pila: {
    spessoreMm: 0.1,
    coverlay: "giallo",
    materiali: [
      { tipo: "coverlay", nome: "PI 12.5um + adhesive 15um", mm: 0.0275 },
      { tipo: "rame", nome: "RA copper 18um", mm: 0.018 },
      { tipo: "poliimmide", nome: "PI 25um", mm: 0.025 },
      { tipo: "coverlay", nome: "PI 12.5um + adhesive 15um", mm: 0.0275 },
    ],
  },
  zone: [
    {
      nome: "coda",
      strati: ["inner1"],
      punti: [
        { x: -18.5, y: -25.75 },
        { x: 18.5, y: -25.75 },
        { x: 18.5, y: -60.75 },
        { x: -18.5, y: -60.75 },
      ],
      finestre: [{ nome: "antenna LTE", punti: [{ x: -16, y: -58 }, { x: -4, y: -58 }, { x: -4, y: -48 }, { x: -16, y: -48 }] }],
      ritagli: [{ nome: "asola vite", punti: [{ x: 8, y: -56 }, { x: 12, y: -56 }, { x: 12, y: -52 }, { x: 8, y: -52 }] }],
      retino: { larghezzaMm: 0.3, passoMm: 0.8, angolo: 45, dove: "piega" },
    },
  ],
  pieghe: [{ nome: "ripiega sulla scheda", da: { x: -18.5, y: -28.75 }, a: { x: 18.5, y: -28.75 }, raggioMm: 1, angolo: 180, verso: "su" }],
  irrigiditori: [
    {
      nome: "rinforzo",
      lato: "bottom",
      materiale: "poliimmide",
      spessoreMm: 0.2,
      punti: [{ x: -2, y: -59 }, { x: 6, y: -59 }, { x: 6, y: -47 }, { x: -2, y: -47 }],
      fori: [{ x: 2, y: -53, diametroMm: 2.2 }],
    },
  ],
  coverlay: { top: [{ nome: "contatto", punti: [{ x: 0, y: -57 }, { x: 4, y: -57 }, { x: 4, y: -55 }, { x: 0, y: -55 }] }], bottom: [] },
};

/**
 * TWO INDEPENDENT FLEXIBLE LAYERS (air gap), the case of the modem boards of
 * Wildy in their v3: a "parte ripiegata" on the sheet with inner2, folded back
 * over the board by two bends of 90 degrees, and a "striscia" on the sheet
 * with inner1, one bend of 90 degrees, whose end turns under the first tail:
 * flat, the two overlap. The outline of the board in main.tsx is all the
 * material (rigid part, both tails flat) and the gap closed between the two
 * tails is a <cutout>. Solid copper (no retino): what Antenova asked for.
 */
export const ESEMPIO_FLEX_DUE_STRATI = {
  pila: {
    spessoreMm: 0.1,
    coverlay: "giallo",
    flessibili: [
      { nome: "foglio inner2", strati: ["inner2"] },
      { nome: "foglio inner1", strati: ["inner1"] },
    ],
  },
  zone: [
    {
      nome: "parte ripiegata",
      flessibile: "foglio inner2",
      punti: [
        { x: -16.25, y: -25.75 },
        { x: 14.2, y: -25.75 },
        { x: 14.2, y: -60 },
        { x: -16.25, y: -60 },
      ],
    },
    {
      nome: "striscia",
      flessibile: "foglio inner1",
      punti: [
        { x: 14.7, y: -25.75 },
        { x: 20.75, y: -25.75 },
        { x: 20.75, y: -62 },
        { x: -30, y: -62 },
        { x: -30, y: -56 },
        { x: 14.7, y: -56 },
      ],
    },
  ],
  pieghe: [
    { nome: "ripiegata 1", zona: "parte ripiegata", da: { x: -16.25, y: -28.117 }, a: { x: 14.2, y: -28.117 }, raggioMm: 2.2, angolo: 90, verso: "su" },
    { nome: "ripiegata 2", zona: "parte ripiegata", da: { x: -16.25, y: -34.002 }, a: { x: 14.2, y: -34.002 }, raggioMm: 2.2, angolo: 90, verso: "su" },
    { nome: "striscia", zona: "striscia", da: { x: 14.7, y: -28.117 }, a: { x: 20.75, y: -28.117 }, raggioMm: 2.2, angolo: 90, verso: "su" },
  ],
  irrigiditori: [
    {
      nome: "rinforzo vite",
      zona: "parte ripiegata",
      lato: "bottom",
      materiale: "fr4",
      spessoreMm: 0.8,
      punti: [{ x: 5.7, y: -50.419 }, { x: 13.4, y: -50.419 }, { x: 13.4, y: -42.719 }, { x: 5.7, y: -42.719 }],
      fori: [{ x: 9.7, y: -46.719, diametroMm: 2.4 }],
    },
  ],
};

/** the file, for whoever writes it: the agent's write_file and the MCP's instructions */
export const DESCRIZIONE_FLEX =
  `${FLEX_PATH} makes the board a RIGID-FLEX one: it says which part of the board's outline is flexible. ` +
  `FIRST draw the whole piece in main.tsx: <board outline={[...]}> is ONE outline, the rigid part and every flexible tail together (the Edge_Cuts of the Gerber), and compile; ` +
  `THEN write ${FLEX_PATH} and compile again. Board coordinates in mm (board centre 0,0, y up, as seen from the top on both faces). A complete file, ` +
  `a one-layer ground tail 37mm wide and 0.1mm thick that leaves the bottom edge and folds back over the board by 180 degrees: ${JSON.stringify(ESEMPIO_FLEX)}. ` +
  `pila (required): the stack of the flexible part, spessoreMm ${SPESSORE_FLEX.min}..${SPESSORE_FLEX.max} (coverlay included, stiffeners not), coverlay ${Object.keys(COVERLAY).join("/")}, ` +
  `materiali optional, top to bottom, tipo ${Object.keys(TIPI_DI_MATERIALE).join("/")}: it is written in the stack note for the fab. ` +
  `zone (1 to ${MAX_ZONE}): a polygon of 3 to ${MAX_VERTICI_FLEX} vertices inside the board's outline, a unique nome, and strati, the copper layers that exist in the zone ` +
  `(a subset of the board's: top, inner1, inner2, bottom...; one layer, e.g. ["inner1"], is a single-layer tail); every other layer ends where the zone starts. ` +
  `Write the vertices of a zone that are on the outline with the outline's own coordinates: a side of the zone ON the outline is where the tail is cut, a side INSIDE the board ` +
  `(even by a few hundredths) is where the rigid part ends. ` +
  `In a zone, optional: finestre (up to ${MAX_FINESTRE}), windows WITHOUT COPPER on any layer, the laminate stays (the free area an antenna asks for); and ritagli (up to ${MAX_FINESTRE}), ` +
  `CUTOUTS, holes cut through the tail, which also go on the outline of the Gerber. Each a polygon inside the zone. ` +
  `And retino, the copper of the zone as a GRID instead of solid (PCB Basic asks hatched ground on the flexible part): {"larghezzaMm": 0.3, "passoMm": 0.8, "angolo": 45, "dove": "piega"}, ` +
  `lines larghezzaMm wide (not under the project's minTraceWidthMm) every passoMm, turned by angolo (0..90), dove "piega" (the stretch each bend of the zone curves, and margineMm, ` +
  `${MARGINE_RETINO_MM}mm unless written, beyond it on each side) or "tutta" (the whole zone); the pours of the zone's layers are cut into it by the compile and stay solid elsewhere, ` +
  `one piece joined to the plane of the rigid part (a square is cut only where a line's width of copper stays all around it). ` +
  `pieghe (up to ${MAX_PIEGHE}): a segment da-a across one zone, raggioMm the inner radius, angolo in degrees (above 0, up to 180: 180 folds the tail back over the board), ` +
  `verso "su" (the tail folds towards the top face) or "giu". What curves is a stretch of tail as long as the arc, angolo in radians x (raggioMm + spessoreMm/2), half on each side of the line ` +
  `(3.3mm for 180 degrees at 1mm on a 0.1mm tail): keep the line at least half of it from the rigid part. ` +
  `irrigiditori (up to ${MAX_IRRIGIDITORI}): a polygon glued on lato top/bottom, materiale ${Object.keys(MATERIALI_IRRIGIDITORE).join("/")}, spessoreMm, optional fori (through the stiffener). ` +
  `coverlay: openings of the coverlay per face, each inside a zone; the pads of a zone get theirs by themselves. Names: letters, digits, spaces and plain punctuation. ` +
  `What the compile then does: the pours of the layers a zone does not declare are cut back from it, and those of its layers from its windows and cutouts (put the copper the tail needs on a ` +
  `declared layer: a <copperpour> over the tail, overlapping the plane of the rigid part); the mask and the silkscreen do not enter the zone (coverlay there); the DRC says, each with its red dot: ` +
  `flex_plated_hole (a via or a plated hole in a zone, or with its copper nearer than minPlatedHoleToFlexMm, 0.5mm, to the stretch of tail a bend curves or to the rigid/flex boundary), ` +
  `flex_copper_layer (a pad, a trace or a pour of a layer the zone does not declare), flex_copper_window (copper in a window), flex_component (a part in a zone and not over a stiffener of the ` +
  `other face), flex_edge_clearance (copper nearer than minFlexEdgeClearanceMm, 0.25mm, to the cut edge of the zone or of a cutout), flex_bend_radius (inner radius under 10, 12 or 24 times ` +
  `pila.spessoreMm for 1, 2 or more copper layers, or under minBendRadiusPerThickness), flex_bend_area (the stretch a bend curves leaves the zone: the bend would start in the rigid part), ` +
  `flex_stiffener_bend (a stiffener over that stretch) and, as a warning, flex_bend_crossing (a trace crossing a bend line more than 10 degrees off the perpendicular). The three thresholds ` +
  `are fields of design-rules.json. The Gerber package gets Mech_RigidFlex.gbr (zones, windows and bend lines), F_Coverlay.gbr and B_Coverlay.gbr, F_Stiffener.gbr / B_Stiffener.gbr and ` +
  `RigidFlex_Stackup.txt for the fab. Checked whole when written: one wrong entry refuses the file with the reasons, and so does a zone that leaves the outline of the board as last compiled. ` +
  `Without the file the board is rigid. ` +
  `TWO OR MORE INDEPENDENT FLEXIBLE LAYERS (air gap: tails of different sheets, bonded together only inside the rigid part, that flat lie ON TOP of each other): ` +
  `pila.flessibili, 2 to ${MAX_STRATI_FLESSIBILI} sheets {"nome", "strati": the copper layers of the board that go on into that sheet (each layer in one sheet at most), optional spessoreMm, coverlay, materiali}; ` +
  `every zone then says "flessibile" (its sheet; its strati default to the sheet's) and zones of DIFFERENT sheets may overlap (of the same sheet never). The <board outline> in main.tsx is then ALL the material, ` +
  `the rigid part and every tail flat; a gap closed between two tails is a <cutout> of the board; the rigid part is what is in the outline and in no zone. A bend, a stiffener and a coverlay opening ` +
  `that lie where two zones overlap name theirs with "zona" (write it always, it is clearer). What changes: the copper of a layer belongs to the zone of the sheet that has it (a pour is cut back from ` +
  `a zone without its layer only where no zone with it lies over it), a cutout cuts one sheet only (it is on that sheet's profile, not on Edge_Cuts), each tail folds in 3D on its own; the DRC adds ` +
  `flex_layer_overlap (two zones of one sheet overlapping) and flex_slot (two tails of two sheets leaving the rigid part nearer than minFlexSlotMm, 0.5mm); the Gerber package gets, per sheet k, ` +
  `Flex<k>_Profile.gbr (where that sheet is cut, and its bends) and Flex<k>_F_Coverlay.gbr / Flex<k>_B_Coverlay.gbr, and the stack note describes the sheets. Example: ${JSON.stringify(ESEMPIO_FLEX_DUE_STRATI)} ` +
  `(in main.tsx the outline goes round the rigid part and both tails, and the gap between them, x 14.2 to 14.7 down to y -56, is a <cutout shape="polygon">).`;

/** flex.json as it was read: what is right in it */
export interface FlexDelFile {
  pila: PilaFlessibile | null;
  zone: Array<{
    indice: number;
    nome: string;
    punti: Punto[];
    strati: string[];
    /** the independent flexible layer it is on (pila.flessibili), on a board that has them */
    flessibile?: string;
    /** windows without copper, and cutouts through the tail: each inside the zone */
    finestre: Array<{ nome?: string; punti: Punto[] }>;
    ritagli: Array<{ nome?: string; punti: Punto[] }>;
    /** the grid its copper is cut into (see flex-retino.ts) */
    retino?: Retino;
  }>;
  pieghe: Array<{ indice: number; nome?: string; a: Punto; b: Punto; raggioMm: number; angolo: number; verso: "su" | "giu"; zona?: string }>;
  irrigiditori: Array<{
    indice: number;
    nome?: string;
    lato: Faccia;
    punti: Punto[];
    materiale: string;
    spessoreMm: number;
    fori: Array<{ x: number; y: number; diametroMm: number }>;
    zona?: string;
  }>;
  aperture: Array<{ lato: Faccia; indice: number; nome?: string; punti: Punto[]; zona?: string }>;
}

/** the board a file is checked against: its outline and its copper layers */
export interface SchedaDelFlessibile {
  contorno: Punto[];
  strati: string[];
}

/** the rules of the project a file is checked against: the narrowest copper and the narrowest gap it allows (mm) */
export interface RegoleDelFlessibile {
  larghezzaMinimaMm: number;
  distanzaMinimaMm: number;
}

const finito = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const arrotonda = (v: number) => Number(v.toFixed(6)) || 0;
const oggetto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** a key worth repeating in a message: a short identifier, nothing else of what was sent */
const chiaveSicura = (k: string) => (/^[A-Za-z_]\w{0,30}$/.test(k) ? k : "dal nome non valido");

/** the fields of an entry that the file does not know, said by number and never by name */
function campiSconosciuti(v: Record<string, unknown>, ammessi: readonly string[], dove: string, errori: string[]): boolean {
  const sbagliati = Object.keys(v).filter((k) => !ammessi.includes(k));
  if (sbagliati.length === 0) return false;
  errori.push(`${dove}: ${sbagliati.length === 1 ? "un campo sconosciuto" : `${sbagliati.length} campi sconosciuti`} (ammessi ${ammessi.join(", ")})`);
  return true;
}

/** a point {"x": ..., "y": ...} in mm, or null */
function leggiPunto(v: unknown): Punto | null {
  if (!oggetto(v) || !Object.keys(v).every((k) => k === "x" || k === "y")) return null;
  if (!finito(v.x) || !finito(v.y) || Math.abs(v.x) > COORDINATA_MASSIMA_MM || Math.abs(v.y) > COORDINATA_MASSIMA_MM) return null;
  return { x: arrotonda(v.x), y: arrotonda(v.y) };
}

/** whether two sides of a polygon that do not share a vertex cross */
function siIncrocia(p: Punto[]): boolean {
  const n = p.length;
  const verso = (a: Punto, b: Punto, c: Punto) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = p[j];
      const d = p[(j + 1) % n];
      if (verso(a, b, c) * verso(a, b, d) < 0 && verso(c, d, a) * verso(c, d, b) < 0) return true;
    }
  }
  return false;
}

/** a polygon of the file: its vertices, or null with the reason said */
function leggiPoligono(v: unknown, dove: string, errori: string[]): Punto[] | null {
  if (!Array.isArray(v) || v.length < 3 || v.length > MAX_VERTICI_FLEX) {
    errori.push(`${dove}: serve un elenco da 3 a ${MAX_VERTICI_FLEX} vertici {"x": ..., "y": ...}`);
    return null;
  }
  const letti = v.map(leggiPunto);
  if (letti.some((q) => q === null)) {
    errori.push(`${dove}: ogni vertice e' {"x": ..., "y": ...}, due numeri in mm`);
    return null;
  }
  const p = letti as Punto[];
  if (siIncrocia(p)) {
    errori.push(`${dove}: due lati del poligono si incrociano`);
    return null;
  }
  if (Math.abs(areaConSegno(p)) < AREA_MINIMA_MM2) {
    errori.push(`${dove}: il poligono non ha area`);
    return null;
  }
  return p;
}

/** a name of the file, when it has one: undefined without, null (said) when it is not one */
function leggiNome(v: unknown, dove: string, errori: string[]): string | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v === "string" && NOME.test(v)) return v;
  errori.push(`${dove}: un testo da 1 a 60 caratteri, lettere, cifre, spazi e _ . , : + ( ) / % -`);
  return null;
}

/** whether a polygon lies on the board: every vertex and every side of it, walked in steps */
function sullaScheda(p: Punto[], contorno: Punto[]): boolean {
  if (contorno.length < 3) return true;
  // the vertices first: a polygon drawn off the board is refused without walking its sides
  if (!p.every((q) => profondita(q.x, q.y, contorno) >= -SLACK_MM)) return false;
  for (const l of latiDi(p)) {
    const passi = Math.min(400, Math.max(1, Math.ceil(Math.hypot(l.bx - l.ax, l.by - l.ay) / 0.5)));
    for (let k = 0; k <= passi; k++) {
      if (profondita(l.ax + ((l.bx - l.ax) * k) / passi, l.ay + ((l.by - l.ay) * k) / passi, contorno) < -SLACK_MM) return false;
    }
  }
  return true;
}

/** whether two polygons share more than their edge: a vertex of one well inside the other, or two sides that cut each other */
function siSovrappongono(a: Punto[], b: Punto[]): boolean {
  if (a.some((p) => profondita(p.x, p.y, b) > 2 * SLACK_MM) || b.some((p) => profondita(p.x, p.y, a) > 2 * SLACK_MM)) return true;
  const verso = (p: Punto, q: Punto, r: Punto) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const r = b[j];
      const s = b[(j + 1) % b.length];
      if (verso(p, q, r) * verso(p, q, s) < -1e-9 && verso(r, s, p) * verso(r, s, q) < -1e-9) return true;
    }
  }
  return false;
}

/**
 * A flex.json, checked entry by entry: what is right is kept, what is wrong is
 * said in `errori` by its place (zone[0].punti) and left out. Nothing of what
 * was sent comes back in a message but numbers and the names of the fields the
 * file may have. `scheda`, when given, is the board as last compiled: a zone, a
 * stiffener or an opening that leaves its outline is wrong too, and so is a
 * layer the board does not have. `regole`, when given, are the project's: a
 * grid with a line under its minimum trace width, or a square between two
 * lines under its minimum clearance, is wrong.
 */
function validaFlex(data: unknown, scheda?: SchedaDelFlessibile, regole?: RegoleDelFlessibile): { flex: FlexDelFile; errori: string[] } {
  const flex: FlexDelFile = { pila: null, zone: [], pieghe: [], irrigiditori: [], aperture: [] };
  const errori: string[] = [];
  if (!oggetto(data)) return { flex, errori: ['serve un oggetto {"pila": {...}, "zone": [...], "pieghe": [...], "irrigiditori": [...], "coverlay": {...}}'] };
  const CAMPI = ["pila", "zone", "pieghe", "irrigiditori", "coverlay"];
  for (const k of Object.keys(data)) {
    if (!CAMPI.includes(k)) errori.push(`campo sconosciuto ${chiaveSicura(k)} (ammessi ${CAMPI.join(", ")})`);
  }

  // --- the stack of the flexible part
  const pila = data.pila;
  if (!oggetto(pila)) {
    errori.push('pila: manca, serve {"spessoreMm": ..., "coverlay": ...}: lo spessore della parte flessibile decide il raggio minimo di piega');
  } else if (!campiSconosciuti(pila, ["spessoreMm", "coverlay", "materiali", "flessibili"], "pila", errori)) {
    let giusta = true;
    if (!finito(pila.spessoreMm) || pila.spessoreMm < SPESSORE_FLEX.min || pila.spessoreMm > SPESSORE_FLEX.max) {
      errori.push(`pila.spessoreMm: lo spessore della parte flessibile in mm, un numero da ${SPESSORE_FLEX.min} a ${SPESSORE_FLEX.max}`);
      giusta = false;
    }
    if (voce(COVERLAY, pila.coverlay) === undefined) {
      errori.push(`pila.coverlay: deve essere uno di ${Object.keys(COVERLAY).join(", ")}`);
      giusta = false;
    }
    const materiali: PilaFlessibile["materiali"] = [];
    if (pila.materiali !== undefined) {
      if (!Array.isArray(pila.materiali) || pila.materiali.length > MAX_MATERIALI) {
        errori.push(`pila.materiali: serve un elenco di al massimo ${MAX_MATERIALI} righe {"tipo": ..., "mm": ...}, dall'alto al basso`);
        giusta = false;
      } else {
        pila.materiali.forEach((m, i) => {
          const dove = `pila.materiali[${i}]`;
          if (!oggetto(m)) {
            errori.push(`${dove}: serve un oggetto {"tipo": ..., "mm": ...} (facoltativo nome)`);
            giusta = false;
            return;
          }
          if (campiSconosciuti(m, ["tipo", "nome", "mm"], dove, errori)) {
            giusta = false;
            return;
          }
          const nome = leggiNome(m.nome, `${dove}.nome`, errori);
          if (typeof m.tipo !== "string" || voce(TIPI_DI_MATERIALE, m.tipo) === undefined) errori.push(`${dove}.tipo: deve essere uno di ${Object.keys(TIPI_DI_MATERIALE).join(", ")}`);
          else if (!finito(m.mm) || m.mm <= 0 || m.mm > 2) errori.push(`${dove}.mm: lo spessore in mm, un numero maggiore di 0 e fino a 2`);
          else if (nome !== null) {
            materiali.push({ tipo: m.tipo, ...(nome ? { nome } : {}), mm: m.mm });
            return;
          }
          giusta = false;
        });
      }
    }
    // the independent flexible layers (air gap): each with the copper layers of the board that go on into it
    let flessibili: NonNullable<PilaFlessibile["flessibili"]> | undefined;
    if (pila.flessibili !== undefined) {
      flessibili = [];
      const v = pila.flessibili;
      if (!Array.isArray(v) || v.length < 2 || v.length > MAX_STRATI_FLESSIBILI) {
        errori.push(`pila.flessibili: serve un elenco da 2 a ${MAX_STRATI_FLESSIBILI} strati flessibili indipendenti {"nome": ..., "strati": [...]} (con uno solo non serve: basta la pila)`);
        giusta = false;
      } else {
        const giaUsati = new Set<string>();
        v.forEach((f, i) => {
          const dove = `pila.flessibili[${i}]`;
          if (!oggetto(f)) {
            errori.push(`${dove}: serve un oggetto {"nome": ..., "strati": [...]} (facoltativi spessoreMm, coverlay, materiali)`);
            giusta = false;
            return;
          }
          if (campiSconosciuti(f, ["nome", "strati", "spessoreMm", "coverlay", "materiali"], dove, errori)) {
            giusta = false;
            return;
          }
          const nome = leggiNome(f.nome, `${dove}.nome`, errori);
          if (!nome || flessibili!.some((g) => g.nome === nome)) {
            if (nome) errori.push(`${dove}.nome: un altro strato flessibile ha lo stesso nome`);
            else if (nome === undefined) errori.push(`${dove}.nome: manca, ogni strato flessibile ha un nome`);
            giusta = false;
            return;
          }
          const st = f.strati;
          if (!Array.isArray(st) || st.length === 0 || !st.every(eStratoDiRame) || new Set(st).size !== st.length) {
            errori.push(`${dove}.strati: serve un elenco senza doppi degli strati di rame della scheda che continuano in questo strato flessibile (top, inner1, ..., bottom), almeno uno`);
            giusta = false;
            return;
          }
          if ((st as string[]).some((l) => giaUsati.has(l))) {
            errori.push(`${dove}.strati: uno strato di rame continua in un solo strato flessibile`);
            giusta = false;
            return;
          }
          if (scheda && !(st as string[]).every((l) => scheda.strati.includes(l))) {
            errori.push(`${dove}.strati: la scheda ha gli strati ${scheda.strati.join(", ")}`);
            giusta = false;
            return;
          }
          if (f.spessoreMm !== undefined && (!finito(f.spessoreMm) || f.spessoreMm < SPESSORE_FLEX.min || f.spessoreMm > SPESSORE_FLEX.max)) {
            errori.push(`${dove}.spessoreMm: lo spessore di questo strato flessibile in mm, da ${SPESSORE_FLEX.min} a ${SPESSORE_FLEX.max} (senza: quello della pila)`);
            giusta = false;
            return;
          }
          if (f.coverlay !== undefined && voce(COVERLAY, f.coverlay) === undefined) {
            errori.push(`${dove}.coverlay: deve essere uno di ${Object.keys(COVERLAY).join(", ")}`);
            giusta = false;
            return;
          }
          const suoi: PilaFlessibile["materiali"] = [];
          if (f.materiali !== undefined) {
            if (!Array.isArray(f.materiali) || f.materiali.length > MAX_MATERIALI) {
              errori.push(`${dove}.materiali: serve un elenco di al massimo ${MAX_MATERIALI} righe {"tipo": ..., "mm": ...}`);
              giusta = false;
              return;
            }
            for (const [k, m] of f.materiali.entries()) {
              const qui = `${dove}.materiali[${k}]`;
              if (!oggetto(m) || campiSconosciuti(m, ["tipo", "nome", "mm"], qui, errori) || voce(TIPI_DI_MATERIALE, m.tipo) === undefined || !finito(m.mm) || m.mm <= 0 || m.mm > 2) {
                errori.push(`${qui}: serve {"tipo": ${Object.keys(TIPI_DI_MATERIALE).join("/")}, "mm": da 0 a 2} (facoltativo nome)`);
                giusta = false;
                return;
              }
              const n = leggiNome(m.nome, `${qui}.nome`, errori);
              if (n === null) {
                giusta = false;
                return;
              }
              suoi.push({ tipo: m.tipo as string, ...(n ? { nome: n } : {}), mm: m.mm });
            }
          }
          for (const l of st as string[]) giaUsati.add(l);
          flessibili!.push({
            nome,
            strati: stratiDiRame(8).filter((l) => (st as string[]).includes(l)),
            spessoreMm: finito(f.spessoreMm) ? f.spessoreMm : (pila.spessoreMm as number),
            coverlay: typeof f.coverlay === "string" ? f.coverlay : (pila.coverlay as string),
            materiali: suoi,
          });
        });
      }
    }
    if (giusta) flex.pila = { spessoreMm: pila.spessoreMm as number, coverlay: pila.coverlay as string, materiali, ...(flessibili ? { flessibili } : {}) };
  }
  /** the independent flexible layers of the stack: empty on a board with one flexible part */
  const flessibili = flex.pila?.flessibili ?? [];
  const fraStrati = oggetto(pila) && pila.flessibili !== undefined;

  // --- the zones
  const zone = data.zone;
  if (!Array.isArray(zone) || zone.length === 0) {
    errori.push('zone: serve un elenco con almeno una zona {"nome": ..., "strati": [...], "punti": [...]}');
  } else {
    if (zone.length > MAX_ZONE) errori.push(`zone: troppe (${zone.length}, massimo ${MAX_ZONE})`);
    const nomi = new Set<string>();
    zone.slice(0, MAX_ZONE).forEach((z, indice) => {
      const dove = `zone[${indice}]`;
      if (!oggetto(z)) {
        errori.push(`${dove}: serve un oggetto {"nome": ..., "strati": [...], "punti": [...]}`);
        return;
      }
      if (campiSconosciuti(z, ["nome", "strati", "punti", "finestre", "ritagli", "retino", "flessibile"], dove, errori)) return;
      if (z.nome === undefined) {
        errori.push(`${dove}.nome: manca, ogni zona ha un nome`);
        return;
      }
      const nome = leggiNome(z.nome, `${dove}.nome`, errori);
      if (!nome) return;
      if (nomi.has(nome)) {
        errori.push(`${dove}.nome: un'altra zona ha lo stesso nome`);
        return;
      }
      // on a stack of independent flexible layers, the zone is on one of them and its copper is that layer's
      let suoStrato: (typeof flessibili)[number] | undefined;
      if (z.flessibile !== undefined || fraStrati) {
        suoStrato = typeof z.flessibile === "string" ? flessibili.find((f) => f.nome === z.flessibile) : undefined;
        if (!fraStrati) {
          errori.push(`${dove}.flessibile: la pila non dichiara strati flessibili indipendenti (pila.flessibili)`);
          return;
        }
        if (!suoStrato) {
          if (flessibili.length > 0) errori.push(`${dove}.flessibile: serve il nome di uno strato flessibile della pila (${flessibili.map((f) => f.nome).join(", ")})`);
          return;
        }
      }
      const s = z.strati === undefined && suoStrato ? suoStrato.strati : z.strati;
      if (suoStrato && Array.isArray(s) && !s.every((l) => typeof l === "string" && suoStrato.strati.includes(l))) {
        errori.push(`${dove}.strati: lo strato flessibile «${suoStrato.nome}» ha il rame di ${suoStrato.strati.join(", ")}: la zona puo' averne solo di questi`);
        return;
      }
      if (!Array.isArray(s) || s.length === 0 || !s.every(eStratoDiRame) || new Set(s).size !== s.length) {
        errori.push(`${dove}.strati: serve un elenco senza doppi degli strati di rame che esistono nella zona (top, inner1, inner2, ..., bottom), almeno uno`);
        return;
      }
      if (scheda && !s.every((l) => scheda.strati.includes(l))) {
        errori.push(`${dove}.strati: la scheda ha gli strati ${scheda.strati.join(", ")}, la zona puo' averne solo di questi`);
        return;
      }
      const p = leggiPoligono(z.punti, `${dove}.punti`, errori);
      if (!p) return;
      if (scheda && !sullaScheda(p, scheda.contorno)) {
        errori.push(
          `${dove}: esce dal contorno della scheda dell'ultima compilazione. Il contorno della scheda e' uno solo, parte rigida e code insieme` +
            (fraStrati ? ` (con piu' strati flessibili: tutto il materiale, ogni coda spianata, e i vuoti chiusi fra le code come <cutout>)` : "") +
            `: prima si disegna la coda nel <board outline> di main.tsx e si compila, poi si scrive ${FLEX_PATH}`,
        );
        return;
      }
      // two zones may lie on top of each other only on two independent flexible layers
      const sovrapposta = flex.zone.find((altra) => siSovrappongono(altra.punti, p) && (!suoStrato || altra.flessibile === suoStrato.nome));
      if (sovrapposta) {
        errori.push(suoStrato ? `${dove}: si sovrappone alla zona «${sovrapposta.nome}», che e' sullo stesso strato flessibile «${suoStrato.nome}»` : `${dove}: si sovrappone a un'altra zona`);
        return;
      }
      // the windows without copper and the cutouts: each a polygon inside the zone
      const dentro = (campo: "finestre" | "ritagli"): Array<{ nome?: string; punti: Punto[] }> | null => {
        const voci = z[campo];
        if (voci === undefined) return [];
        if (!Array.isArray(voci) || voci.length > MAX_FINESTRE) {
          errori.push(`${dove}.${campo}: serve un elenco di al massimo ${MAX_FINESTRE} poligoni {"punti": [...]} (facoltativo nome)`);
          return null;
        }
        const out: Array<{ nome?: string; punti: Punto[] }> = [];
        for (let k = 0; k < voci.length; k++) {
          const v = voci[k];
          const qui = `${dove}.${campo}[${k}]`;
          if (!oggetto(v)) {
            errori.push(`${qui}: serve un oggetto {"punti": [...]} (facoltativo nome)`);
            return null;
          }
          if (campiSconosciuti(v, ["nome", "punti"], qui, errori)) return null;
          const suoNome = leggiNome(v.nome, `${qui}.nome`, errori);
          if (suoNome === null) return null;
          const q = leggiPoligono(v.punti, `${qui}.punti`, errori);
          if (!q) return null;
          if (!contieneTutti(p, q, 2 * SLACK_MM)) {
            errori.push(`${qui}: deve stare tutto nella sua zona`);
            return null;
          }
          out.push({ ...(suoNome ? { nome: suoNome } : {}), punti: q });
        }
        return out;
      };
      const finestre = dentro("finestre");
      const ritagli = dentro("ritagli");
      if (!finestre || !ritagli) return;
      // the grid of its copper
      let retino: Retino | undefined;
      if (z.retino !== undefined) {
        const r = z.retino;
        const qui = `${dove}.retino`;
        if (!oggetto(r)) {
          errori.push(`${qui}: serve un oggetto {"larghezzaMm": ..., "passoMm": ..., "angolo": ..., "dove": "piega" o "tutta"}`);
          return;
        }
        if (campiSconosciuti(r, ["larghezzaMm", "passoMm", "angolo", "dove", "margineMm"], qui, errori)) return;
        const minima = Math.max(RETINO.larghezzaMin, regole?.larghezzaMinimaMm ?? 0);
        if (!finito(r.larghezzaMm) || r.larghezzaMm < minima - 1e-9 || r.larghezzaMm > RETINO.larghezzaMax) {
          errori.push(
            `${qui}.larghezzaMm: la larghezza delle linee della griglia in mm, un numero da ${minima} a ${RETINO.larghezzaMax}` +
              (regole && regole.larghezzaMinimaMm > RETINO.larghezzaMin ? ` (${minima} e' la pista minima del progetto, minTraceWidthMm)` : ""),
          );
          return;
        }
        const apertura = Math.max(APERTURA_MINIMA_RETINO_MM, regole?.distanzaMinimaMm ?? 0);
        if (!finito(r.passoMm) || r.passoMm > RETINO.passoMax || r.passoMm - r.larghezzaMm < apertura - 1e-9) {
          errori.push(`${qui}.passoMm: il passo della griglia in mm, fino a ${RETINO.passoMax}, e almeno ${apertura} piu' della larghezza delle linee (il quadrato fra due linee)`);
          return;
        }
        if (!finito(r.angolo) || r.angolo < 0 || r.angolo > 90) {
          errori.push(`${qui}.angolo: i gradi di cui e' girata la griglia, un numero da 0 a 90`);
          return;
        }
        if (r.dove !== "piega" && r.dove !== "tutta") {
          errori.push(`${qui}.dove: deve essere "piega" (il tratto che le pieghe della zona curvano) o "tutta" (tutta la zona)`);
          return;
        }
        if (r.margineMm !== undefined && (!finito(r.margineMm) || r.margineMm < 0 || r.margineMm > RETINO.margineMax)) {
          errori.push(`${qui}.margineMm: di quanto la griglia va oltre il tratto in piega, un numero da 0 a ${RETINO.margineMax}`);
          return;
        }
        if (Math.abs(areaConSegno(p)) / (r.passoMm * r.passoMm) > MAX_APERTURE_RETINO) {
          errori.push(`${qui}.passoMm: troppo fitto per questa zona (piu' di ${MAX_APERTURE_RETINO} quadrati)`);
          return;
        }
        retino = { larghezzaMm: r.larghezzaMm, passoMm: r.passoMm, angolo: r.angolo, dove: r.dove, margineMm: finito(r.margineMm) ? r.margineMm : MARGINE_RETINO_MM };
      }
      nomi.add(nome);
      // in the order of the stack, so two files that say the same thing are the same board
      flex.zone.push({
        indice,
        nome,
        punti: p,
        strati: stratiDiRame(8).filter((l) => (s as string[]).includes(l)),
        finestre,
        ritagli,
        ...(retino ? { retino } : {}),
        ...(suoStrato ? { flessibile: suoStrato.nome } : {}),
      });
    });
  }

  /*
   * A bend and an opening of the coverlay are in a zone. When a zone of the
   * file was refused, the ones that are in none are left out without a reason
   * of their own: theirs is the zone's, already said, and they come back with it.
   */
  const zoneRifiutate = Array.isArray(zone) && Math.min(zone.length, MAX_ZONE) > flex.zone.length;

  /**
   * The zone an entry is in: the one it names (`zona`), which must hold it, or
   * the only one that holds it. Where two zones of two flexible layers lie on
   * top of each other the entry must name its own. undefined (said, unless the
   * zone was refused) when there is none; null when it is not one zone.
   */
  const zonaDellaVoce = (v: Record<string, unknown>, dentro: Punto[], dove: string, comeDirlo: string): FlexDelFile["zone"][number] | undefined | null => {
    if (v.zona !== undefined) {
      const z = typeof v.zona === "string" ? flex.zone.find((q) => q.nome === v.zona) : undefined;
      if (!z) {
        if (!zoneRifiutate) errori.push(`${dove}.zona: serve il nome di una zona del file`);
        return undefined;
      }
      if (!contieneTutti(z.punti, dentro, 2 * SLACK_MM)) {
        errori.push(`${dove}: ${comeDirlo} nella zona «${z.nome}» che nomina`);
        return undefined;
      }
      return z;
    }
    const tutte = flex.zone.filter((q) => contieneTutti(q.punti, dentro, 2 * SLACK_MM));
    if (tutte.length > 1 && fraStrati) {
      errori.push(`${dove}: sta in ${tutte.length} zone sovrapposte (${tutte.map((q) => `«${q.nome}»`).join(", ")}): scrivi "zona" con il nome della sua`);
      return null;
    }
    return tutte[0];
  };

  // --- the bend lines
  if (data.pieghe !== undefined) {
    if (!Array.isArray(data.pieghe)) errori.push("pieghe: serve un elenco di linee di piega");
    else {
      if (data.pieghe.length > MAX_PIEGHE) errori.push(`pieghe: troppe (${data.pieghe.length}, massimo ${MAX_PIEGHE})`);
      data.pieghe.slice(0, MAX_PIEGHE).forEach((v, indice) => {
        const dove = `pieghe[${indice}]`;
        if (!oggetto(v)) {
          errori.push(`${dove}: serve un oggetto {"da": {...}, "a": {...}, "raggioMm": ..., "angolo": ..., "verso": ...}`);
          return;
        }
        if (campiSconosciuti(v, ["nome", "da", "a", "raggioMm", "angolo", "verso", "zona"], dove, errori)) return;
        const nome = leggiNome(v.nome, `${dove}.nome`, errori);
        if (nome === null) return;
        const a = leggiPunto(v.da);
        const b = leggiPunto(v.a);
        if (!a || !b) {
          errori.push(`${dove}: da e a sono i due capi della linea, {"x": ..., "y": ...} in mm`);
          return;
        }
        if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) {
          errori.push(`${dove}: la linea di piega e' piu' corta di 0.5 mm`);
          return;
        }
        if (!finito(v.raggioMm) || v.raggioMm < 0.05 || v.raggioMm > 100) {
          errori.push(`${dove}.raggioMm: il raggio interno della piega in mm, un numero da 0.05 a 100`);
          return;
        }
        if (!finito(v.angolo) || v.angolo <= 0 || v.angolo > 180) {
          errori.push(`${dove}.angolo: i gradi della piega, un numero maggiore di 0 e fino a 180`);
          return;
        }
        if (v.verso !== "su" && v.verso !== "giu") {
          errori.push(`${dove}.verso: deve essere "su" (la coda piega verso la faccia top) o "giu"`);
          return;
        }
        // across one zone: its two ends and its middle in the same one
        const meta = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const suaZona = zonaDellaVoce(v, [a, meta, b], dove, "la linea di piega deve stare tutta");
        if (suaZona === null) return;
        if (!suaZona) {
          if (!zoneRifiutate && v.zona === undefined) errori.push(`${dove}: la linea di piega deve stare tutta in una zona flessibile, da un suo bordo all'altro`);
          return;
        }
        flex.pieghe.push({ indice, ...(nome ? { nome } : {}), a, b, raggioMm: v.raggioMm, angolo: v.angolo, verso: v.verso, ...(fraStrati ? { zona: suaZona.nome } : {}) });
      });
    }
  }

  // --- the stiffeners
  if (data.irrigiditori !== undefined) {
    if (!Array.isArray(data.irrigiditori)) errori.push("irrigiditori: serve un elenco di irrigiditori");
    else {
      if (data.irrigiditori.length > MAX_IRRIGIDITORI) errori.push(`irrigiditori: troppi (${data.irrigiditori.length}, massimo ${MAX_IRRIGIDITORI})`);
      data.irrigiditori.slice(0, MAX_IRRIGIDITORI).forEach((v, indice) => {
        const dove = `irrigiditori[${indice}]`;
        if (!oggetto(v)) {
          errori.push(`${dove}: serve un oggetto {"lato": ..., "materiale": ..., "spessoreMm": ..., "punti": [...]}`);
          return;
        }
        if (campiSconosciuti(v, ["nome", "lato", "materiale", "spessoreMm", "punti", "fori", "zona"], dove, errori)) return;
        const nome = leggiNome(v.nome, `${dove}.nome`, errori);
        if (nome === null) return;
        if (v.lato !== "top" && v.lato !== "bottom") {
          errori.push(`${dove}.lato: deve essere "top" o "bottom", la faccia su cui e' incollato`);
          return;
        }
        const materiale = voce(MATERIALI_IRRIGIDITORE, v.materiale);
        if (!materiale || typeof v.materiale !== "string") {
          errori.push(`${dove}.materiale: deve essere uno di ${Object.keys(MATERIALI_IRRIGIDITORE).join(", ")}`);
          return;
        }
        if (!finito(v.spessoreMm) || v.spessoreMm < materiale.min || v.spessoreMm > materiale.max) {
          errori.push(`${dove}.spessoreMm: per questo materiale PCB Basic fa spessori da ${materiale.min} a ${materiale.max} mm`);
          return;
        }
        const p = leggiPoligono(v.punti, `${dove}.punti`, errori);
        if (!p) return;
        if (scheda && !sullaScheda(p, scheda.contorno)) {
          errori.push(`${dove}: esce dal contorno della scheda`);
          return;
        }
        const fori: FlexDelFile["irrigiditori"][number]["fori"] = [];
        if (v.fori !== undefined) {
          if (!Array.isArray(v.fori) || v.fori.length > MAX_FORI) {
            errori.push(`${dove}.fori: serve un elenco di al massimo ${MAX_FORI} fori {"x": ..., "y": ..., "diametroMm": ...}`);
            return;
          }
          for (const f of v.fori) {
            const centro = oggetto(f) && Object.keys(f).every((k) => k === "x" || k === "y" || k === "diametroMm") ? leggiPunto({ x: f.x, y: f.y }) : null;
            const d = oggetto(f) ? f.diametroMm : undefined;
            if (!centro || !finito(d) || d < 0.2 || d > 50 || profondita(centro.x, centro.y, p) < d / 2 - SLACK_MM) {
              errori.push(`${dove}.fori: ogni foro e' {"x": ..., "y": ..., "diametroMm": ...}, da 0.2 a 50 mm e tutto dentro l'irrigiditore`);
              return;
            }
            fori.push({ ...centro, diametroMm: d });
          }
        }
        // on independent flexible layers a stiffener is glued on one sheet: its zone
        let suaZona: string | undefined;
        if (fraStrati || v.zona !== undefined) {
          const z = zonaDellaVoce(v, p, dove, "un irrigiditore deve stare tutto");
          if (z === null) return;
          if (!z) {
            if (!zoneRifiutate && v.zona === undefined) errori.push(`${dove}: con piu' strati flessibili un irrigiditore sta tutto in una zona`);
            return;
          }
          suaZona = z.nome;
        }
        flex.irrigiditori.push({ indice, ...(nome ? { nome } : {}), lato: v.lato, punti: p, materiale: v.materiale, spessoreMm: v.spessoreMm, fori, ...(suaZona ? { zona: suaZona } : {}) });
      });
    }
  }

  // --- the openings of the coverlay
  if (data.coverlay !== undefined) {
    const coverlay = data.coverlay;
    if (!oggetto(coverlay)) errori.push('coverlay: serve un oggetto {"top": [...], "bottom": [...]}');
    else {
      for (const k of Object.keys(coverlay)) {
        if (!(LATI as readonly string[]).includes(k)) errori.push(`coverlay: campo sconosciuto ${chiaveSicura(k)} (ammessi top e bottom)`);
      }
      let totale = 0;
      for (const lato of LATI) {
        const voci = coverlay[lato];
        if (voci === undefined) continue;
        if (!Array.isArray(voci)) {
          errori.push(`coverlay.${lato}: serve un elenco di aperture`);
          continue;
        }
        totale += voci.length;
        voci.slice(0, MAX_APERTURE_COVERLAY).forEach((v, indice) => {
          const dove = `coverlay.${lato}[${indice}]`;
          if (!oggetto(v)) {
            errori.push(`${dove}: serve un oggetto {"punti": [...]} (facoltativo nome)`);
            return;
          }
          if (campiSconosciuti(v, ["nome", "punti", "zona"], dove, errori)) return;
          const nome = leggiNome(v.nome, `${dove}.nome`, errori);
          if (nome === null) return;
          const p = leggiPoligono(v.punti, `${dove}.punti`, errori);
          if (!p) return;
          const suaZona = zonaDellaVoce(v, p, dove, "un'apertura del coverlay deve stare tutta");
          if (suaZona === null) return;
          if (!suaZona) {
            if (!zoneRifiutate && v.zona === undefined) errori.push(`${dove}: un'apertura del coverlay sta tutta in una zona flessibile (fuori non c'e' coverlay)`);
            return;
          }
          flex.aperture.push({ lato, indice, ...(nome ? { nome } : {}), punti: p, ...(fraStrati ? { zona: suaZona.nome } : {}) });
        });
      }
      if (totale > MAX_APERTURE_COVERLAY) errori.push(`coverlay: troppe aperture (${totale}, massimo ${MAX_APERTURE_COVERLAY} fra top e bottom)`);
    }
  }
  return { flex, errori };
}

/** reads flex.json at compile: a broken entry is said and skipped, never guessed. `flex` is null for a project without the file */
export function leggiFlex(fsMap: Record<string, string>): { flex: FlexDelFile | null; avvisi: string[] } {
  const raw = fsMap[FLEX_PATH];
  if (raw === undefined || raw.trim() === "") return { flex: null, avvisi: [] };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { flex: null, avvisi: [`${FLEX_PATH} non e' un JSON valido: ignorato, la scheda e' trattata come rigida`] };
  }
  const { flex, errori } = validaFlex(data);
  return { flex, avvisi: errori.map((e) => `${FLEX_PATH}: ${e}, saltato`) };
}

/**
 * A flex.json written by a tool (write_file), checked WHOLE before it is
 * written: one entry wrong refuses the file with every reason, nothing is
 * saved half-right. `scheda` is the board as last compiled, when there is one:
 * a zone off its outline or on a layer it does not have is refused. `regole`
 * are the project's minimums, for the grid of a zone.
 */
export function validaFileDelFlessibile(
  content: string,
  scheda?: SchedaDelFlessibile,
  regole?: RegoleDelFlessibile,
): { flex: FlexDelFile } | { errori: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return { errori: ["non e' un JSON valido (NaN e Infinity non sono JSON)"] };
  }
  const { flex, errori } = validaFlex(data, scheda, regole);
  return errori.length > 0 ? { errori } : { flex };
}

/** the outline and the copper layers of a board, from its circuit: undefined when it has no board */
export function schedaDelFlessibile(circuitJson: unknown[] | null | undefined): SchedaDelFlessibile | undefined {
  const els = (circuitJson ?? []) as El[];
  const board = els.find((e) => e?.type === "pcb_board");
  const contorno = contornoDellaScheda(els);
  if (!board || contorno.length < 3) return undefined;
  return { contorno, strati: stratiDiRame(typeof board.num_layers === "number" ? board.num_layers : 2) };
}

/** the zones of a file that can be put on a board: on its outline, with the layers the board has */
function zoneSullaScheda(flex: FlexDelFile, scheda: SchedaDelFlessibile | undefined): FlexDelFile["zone"] {
  if (!scheda) return flex.zone;
  return flex.zone
    .filter((z) => sullaScheda(z.punti, scheda.contorno))
    .map((z) => ({ ...z, strati: z.strati.filter((l) => scheda.strati.includes(l)) }));
}

/**
 * WHAT flex.json SAYS, PUT ON THE BOARD, after the mask windows: the zones
 * (with their windows and cutouts), the bends, the stiffeners, the openings of
 * the coverlay and the stack, each as an element of its own (see
 * flex-zone.ts), and every cutout of a zone as a pcb_cutout too; those already
 * there, from a board of before, taken off first. A zone that leaves the board is not put on
 * it, nor a bend that is in no zone that was (avvisiDelFlessibile says so). A
 * board with no file and no such element is given back as it came.
 */
export function conFlessibile<T extends El>(circuitJson: T[], fsMap: Record<string, string>): T[] {
  const giaSopra = circuitJson.some(eDelFlessibile);
  if (fsMap[FLEX_PATH] === undefined && !giaSopra) return circuitJson;
  const out = circuitJson.filter((el) => !eDelFlessibile(el));
  const { flex } = leggiFlex(fsMap);
  if (!flex) return out;
  const zone = zoneSullaScheda(flex, schedaDelFlessibile(out));
  if (zone.length === 0) return out;
  const metti = (el: Record<string, unknown>) => out.push(el as unknown as T);
  // independent flexible layers: every element says its sheet or its zone, and a cutout goes through one sheet only
  const fraStrati = (flex.pila?.flessibili?.length ?? 0) > 0;
  const idDellaZona = (nome: string | undefined) => {
    const z = nome === undefined ? undefined : zone.find((q) => q.nome === nome);
    return z ? `pcb_flex_zone_${z.indice}` : undefined;
  };
  for (const z of zone) {
    metti({
      type: ZONA_FLESSIBILE,
      pcb_flex_zone_id: `pcb_flex_zone_${z.indice}`,
      nome: z.nome,
      layers: z.strati,
      points: z.punti,
      ...(fraStrati && z.flessibile ? { flex_layer: z.flessibile } : {}),
      ...(z.finestre.length > 0 ? { windows: z.finestre.map((f) => ({ ...(f.nome ? { nome: f.nome } : {}), points: f.punti })) } : {}),
      ...(z.ritagli.length > 0 ? { cutouts: z.ritagli.map((f) => ({ ...(f.nome ? { nome: f.nome } : {}), points: f.punti })) } : {}),
      // the grid its copper is to be cut into: conRetino lays it on the pours and writes here how many squares it cut
      ...(z.retino
        ? { hatch: { width_mm: z.retino.larghezzaMm, pitch_mm: z.retino.passoMm, angle_deg: z.retino.angolo, where: z.retino.dove, margin_mm: z.retino.margineMm } }
        : {}),
    });
    /*
     * a cutout is a hole in the board: as a pcb_cutout the outline of the Gerber has it, and whatever reads the cutouts of a board.
     * Not on independent flexible layers: there it cuts one sheet, and another may lie under it (it is on that sheet's profile)
     */
    if (!fraStrati) z.ritagli.forEach((r, k) => {
      metti({ type: "pcb_cutout", pcb_cutout_id: `${RITAGLIO_DEL_FLESSIBILE}${z.indice}_${k}`, shape: "polygon", points: r.punti });
    });
  }
  for (const p of flex.pieghe) {
    const meta = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
    if (!zone.some((z) => contieneTutti(z.punti, [p.a, meta, p.b], 2 * SLACK_MM))) continue;
    const suaZona = idDellaZona(p.zona);
    if (fraStrati && !suaZona) continue;
    metti({
      type: PIEGA,
      pcb_flex_bend_id: `pcb_flex_bend_${p.indice}`,
      ...(fraStrati ? { pcb_flex_zone_id: suaZona } : {}),
      ...(p.nome ? { nome: p.nome } : {}),
      from: p.a,
      to: p.b,
      radius_mm: p.raggioMm,
      angle_deg: p.angolo,
      direction: p.verso,
    });
  }
  for (const r of flex.irrigiditori) {
    const suaZona = idDellaZona(r.zona);
    if (fraStrati && !suaZona) continue;
    metti({
      type: IRRIGIDITORE,
      pcb_flex_stiffener_id: `pcb_flex_stiffener_${r.indice}`,
      ...(suaZona ? { pcb_flex_zone_id: suaZona } : {}),
      ...(r.nome ? { nome: r.nome } : {}),
      layer: r.lato,
      material: r.materiale,
      thickness_mm: r.spessoreMm,
      points: r.punti,
      holes: r.fori.map((f) => ({ x: f.x, y: f.y, diameter_mm: f.diametroMm })),
    });
  }
  for (const a of flex.aperture) {
    if (!zone.some((z) => contieneTutti(z.punti, a.punti, 2 * SLACK_MM))) continue;
    const suaZona = idDellaZona(a.zona);
    if (fraStrati && !suaZona) continue;
    metti({
      type: APERTURA_COVERLAY,
      pcb_flex_coverlay_opening_id: `pcb_flex_coverlay_opening_${a.lato}_${a.indice}`,
      ...(fraStrati ? { pcb_flex_zone_id: suaZona } : {}),
      ...(a.nome ? { nome: a.nome } : {}),
      layer: a.lato,
      points: a.punti,
    });
  }
  if (flex.pila) {
    metti({
      type: PILA_FLESSIBILE,
      pcb_flex_stackup_id: "pcb_flex_stackup_0",
      thickness_mm: flex.pila.spessoreMm,
      coverlay: flex.pila.coverlay,
      materials: flex.pila.materiali,
      ...(fraStrati
        ? {
            flex_layers: flex.pila.flessibili!.map((f) => ({ name: f.nome, copper_layers: f.strati, thickness_mm: f.spessoreMm, coverlay: f.coverlay, materials: f.materiali })),
          }
        : {}),
    });
  }
  return out;
}

/** the layer counts of a flexible part PCB Basic's order form offers */
const STRATI_FLEX_PCB_BASIC = [1, 2, 4, 6, 8, 10];
/** the thinnest flexible part of that form (mm) */
const SPESSORE_MINIMO_PCB_BASIC = 0.08;

/** the silkscreen drawings of a board that enter a flexible zone: they are not printed there */
export function serigrafiaNelFlessibile(circuitJson: El[], flex: Flessibile): El[] {
  const dentro: El[] = [];
  const zone = flex.zone.map((z) => ({ z, lati: latiDi(z.punti) }));
  for (const el of circuitJson) {
    if (typeof el.type !== "string" || !el.type.startsWith("pcb_silkscreen_")) continue;
    const d = disegnoStampato(el);
    if (!d) continue;
    const entra =
      d.segmenti.some(([a, b]) => {
        const m = d.mezzaPenna;
        // a board has thousands of strokes and a tail or two: only those whose box reaches a zone are measured
        const vicine = zone.filter(({ z }) => Math.max(a.x, b.x) + m >= z.minX && Math.min(a.x, b.x) - m <= z.maxX && Math.max(a.y, b.y) + m >= z.minY && Math.min(a.y, b.y) - m <= z.maxY);
        if (vicine.length === 0) return false;
        const meta = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if ([a, meta, b].some((p) => vicine.some(({ z }) => profondita(p.x, p.y, z.punti) > -m))) return true;
        // a long stroke across a narrow tail: neither end in it
        return vicine.some(({ lati }) => lati.some((l) => siIncrociano({ ax: a.x, ay: a.y, bx: b.x, by: b.y }, l)));
      }) || d.regioni.some((r) => r.some((p) => zonaDelPunto(flex, p.x, p.y)));
    if (entra) dentro.push(el);
  }
  return dentro;
}

/**
 * What is wrong with the flexible part of a board, in words, for the
 * electrical checks (rule flex_zone, a warning): an entry of the file that
 * could not be read, a zone off the board or on a layer the board does not
 * have, a bend or an opening left out with it, a stack PCB Basic does not
 * offer, silkscreen that enters a zone and is not printed there. Empty for a
 * project without the file.
 */
export function avvisiDelFlessibile(circuitJson: El[], fsMap: Record<string, string>): Array<{ message: string; x?: number; y?: number }> {
  if (fsMap[FLEX_PATH] === undefined) return [];
  const { flex: delFile, avvisi } = leggiFlex(fsMap);
  const out: Array<{ message: string; x?: number; y?: number }> = avvisi.map((message) => ({ message }));
  if (!delFile) return out;
  const centro = (p: Punto[]) => ({ x: p.reduce((t, q) => t + q.x, 0) / p.length, y: p.reduce((t, q) => t + q.y, 0) / p.length });
  const scheda = schedaDelFlessibile(circuitJson);
  const sopra = flessibileDellaScheda(circuitJson);
  const idSopra = new Set((sopra?.zone ?? []).map((z) => z.id));
  for (const z of delFile.zone) {
    if (!idSopra.has(`pcb_flex_zone_${z.indice}`)) {
      out.push({
        message:
          `${FLEX_PATH}: la zona «${z.nome}» esce dal contorno della scheda: non e' stata messa e la scheda li' e' trattata come rigida. ` +
          `Il contorno e' uno solo, parte rigida e code insieme: va disegnato nel <board outline> di main.tsx`,
        ...centro(z.punti),
      });
      continue;
    }
    const mancanti = scheda ? z.strati.filter((l) => !scheda.strati.includes(l)) : [];
    if (mancanti.length > 0) {
      out.push({ message: `${FLEX_PATH}: la zona «${z.nome}» dichiara ${mancanti.join(", ")}, che la scheda non ha (${scheda?.strati.join(", ")})`, ...centro(z.punti) });
    }
    const quanti = z.strati.length - mancanti.length;
    if (!STRATI_FLEX_PCB_BASIC.includes(quanti)) {
      out.push({
        message: `${FLEX_PATH}: la zona «${z.nome}» ha ${quanti} strati di rame: PCB Basic fa parti flessibili a ${STRATI_FLEX_PCB_BASIC.join(", ")} strati`,
        ...centro(z.punti),
      });
    }
  }
  const pieghe = new Set((sopra?.pieghe ?? []).map((p) => p.id));
  for (const p of delFile.pieghe) {
    if (pieghe.has(`pcb_flex_bend_${p.indice}`)) continue;
    out.push({ message: `${FLEX_PATH}: la piega «${p.nome ?? `pieghe[${p.indice}]`}» non sta in una zona messa sulla scheda: non e' stata messa`, x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 });
  }
  if (delFile.pila && delFile.pila.spessoreMm < SPESSORE_MINIMO_PCB_BASIC) {
    out.push({ message: `${FLEX_PATH}: pila.spessoreMm ${delFile.pila.spessoreMm}: la parte flessibile piu' sottile di PCB Basic e' ${SPESSORE_MINIMO_PCB_BASIC} mm` });
  }
  for (const f of delFile.pila?.flessibili ?? []) {
    if (f.spessoreMm < SPESSORE_MINIMO_PCB_BASIC) out.push({ message: `${FLEX_PATH}: lo strato flessibile «${f.nome}» e' spesso ${f.spessoreMm} mm: il piu' sottile di PCB Basic e' ${SPESSORE_MINIMO_PCB_BASIC} mm` });
  }
  for (const z of sopra?.zone ?? []) {
    const r = z.retino;
    if (!r) continue;
    if (r.nonApplicato === "larghezza") {
      out.push({
        message: `${FLEX_PATH}: il retino della zona «${z.nome}» ha linee da ${r.larghezzaMm} mm, sotto la pista minima del progetto (minTraceWidthMm): non e' stato applicato, il rame della zona e' pieno`,
        ...centro(z.punti),
      });
    } else if (r.aperture === 0) {
      out.push({
        message:
          `${FLEX_PATH}: il retino della zona «${z.nome}» non ha tagliato nessun quadrato, il rame della zona e' pieno: ` +
          (r.dove === "piega" && !sopra?.pieghe.some((p) => p.zona === z)
            ? `e' chiesto sulla piega e la zona non ha pieghe`
            : `sugli strati della zona (${z.strati.join(", ")}) non c'e' una colata abbastanza larga li' (il rame della coda si mette con un <copperpour> su uno strato dichiarato)`),
        ...centro(z.punti),
      });
    }
  }
  if (sopra && !sopra.pila) {
    out.push({ message: `${FLEX_PATH}: manca la pila della parte flessibile (pila.spessoreMm): il raggio delle pieghe non e' controllato` });
  }
  if (sopra) {
    for (const z of sopra.zone) {
      const disegni = serigrafiaNelFlessibile(circuitJson, { ...sopra, zone: [z] });
      if (disegni.length === 0) continue;
      const primo = disegnoStampato(disegni[0])?.segmenti[0]?.[0];
      out.push({
        message:
          `${disegni.length === 1 ? "un disegno di serigrafia entra" : `${disegni.length} disegni di serigrafia entrano`} nella zona flessibile «${z.nome}»: ` +
          `non ${disegni.length === 1 ? "viene scritto" : "vengono scritti"} nel Gerber, sul flessibile c'e' il coverlay`,
        ...(primo ? { x: primo.x, y: primo.y } : {}),
      });
    }
  }
  return out;
}

/**
 * THE FLEXIBLE ZONES AS OBSTACLES OF THE POURS (see ricolaPiani in
 * pours-recompute.ts), by copper layer. Read from the files, because the
 * planes are poured before the zones are put on the board.
 *
 *  - On a layer a zone does NOT declare, the zone is a hole in that layer: the
 *    whole polygon, and around it the board's edge clearance, because where
 *    the zone starts that layer ends as it ends at the edge of the board. The
 *    clearance is drawn the way the band along the outline is (one capsule
 *    per side), so the plane of a rigid board keeps, where a tail is attached
 *    to it, the very edge it had before the tail.
 *  - On a layer it declares, the copper goes on into the zone, and stops at
 *    its windows, which are subtracted as they are drawn (a window is where
 *    the copper is not, to the line), and around its cutouts, which are a cut
 *    edge like the outline: grown by the wider of the board's edge clearance
 *    and the flexible one. Along the cut edge of the zone it keeps the
 *    flexible edge clearance, when that asks more than the board's (which the
 *    band of the edge already keeps): one capsule per stretch of edge.
 *
 * undefined for a project without a zone on the board: the pours are poured as
 * they always were.
 */
export function ostacoliDelFlessibile(
  circuitJson: unknown[],
  fsMap: Record<string, string>,
  bordoMm: number,
  bordoFlessibileMm: number,
): ((strato: string) => Array<Record<string, unknown>>) | undefined {
  const { flex } = leggiFlex(fsMap);
  if (!flex) return undefined;
  const scheda = schedaDelFlessibile(circuitJson);
  const zone = zoneSullaScheda(flex, scheda);
  if (zone.length === 0) return undefined;
  if ((flex.pila?.flessibili?.length ?? 0) > 0) return ostacoliFraStrati(circuitJson as El[], zone, bordoMm, bordoFlessibileMm);
  const sulBordo = zone.map((z) => {
    // the sides of the zone that are the edge of the board, as flex-zone.ts tells them apart on the board
    const comeSopra = flessibileDellaScheda([
      ...((circuitJson as El[]).filter((el) => el?.type === "pcb_board") as El[]),
      { type: ZONA_FLESSIBILE, pcb_flex_zone_id: "z", layers: z.strati, points: z.punti },
    ]);
    return comeSopra?.zone[0]?.bordi ?? [];
  });
  const antiorario = (punti: Punto[]) => (areaConSegno(punti) < 0 ? [...punti].reverse() : punti);
  const taglio = Math.max(bordoMm, bordoFlessibileMm);
  return (strato) => {
    const fuori: Array<Record<string, unknown>> = [];
    /** a polygon the copper of this layer stays out of, grown by `margineMm` with round corners (see ostacoliEsatti) */
    const buco = (id: string, punti: Punto[], margineMm: number) => {
      const p = antiorario(punti);
      fuori.push({
        shape: "polygon",
        padId: id,
        layer: strato,
        // neither hole nor cutout: subtracted as it is given
        connectivityKey: `unconnected:${id}`,
        points: p,
        ...(margineMm > 0 ? { formaEsatta: { tipo: "poligono", punti: p }, margineMm } : {}),
      });
    };
    zone.forEach((z, i) => {
      if (!z.strati.includes(strato)) {
        buco(`flessibile_${z.indice}`, z.punti, 0);
        // and the board's edge clearance around it, drawn as along the outline of the board (bandaDelBordo): one capsule per side
        if (bordoMm > 0) {
          latiDi(z.punti).forEach((l, k) => {
            if (Math.hypot(l.bx - l.ax, l.by - l.ay) < 1e-9) return;
            fuori.push({
              shape: "polygon",
              padId: `flessibile_${z.indice}_lato_${k}`,
              layer: strato,
              connectivityKey: `unconnected:flessibile_${z.indice}_lato_${k}`,
              points: capsula({ x: l.ax, y: l.ay }, { x: l.bx, y: l.by }, bordoMm),
            });
          });
        }
        return;
      }
      z.finestre.forEach((f, k) => buco(`flessibile_${z.indice}_finestra_${k}`, f.punti, 0));
      z.ritagli.forEach((r, k) => buco(`flessibile_${z.indice}_ritaglio_${k}`, r.punti, taglio));
      if (bordoFlessibileMm > bordoMm) {
        sulBordo[i].forEach((l, k) => {
          fuori.push({
            shape: "polygon",
            padId: `flessibile_${z.indice}_bordo_${k}`,
            layer: strato,
            connectivityKey: `unconnected:flessibile_${z.indice}_bordo_${k}`,
            points: capsula({ x: l.ax, y: l.ay }, { x: l.bx, y: l.by }, bordoFlessibileMm),
          });
        });
      }
    });
    return fuori;
  };
}

/**
 * THE OBSTACLES OF THE POURS ON INDEPENDENT FLEXIBLE LAYERS. As for one
 * flexible part, with what two sheets lying on top of each other change:
 *  - on a layer a zone does not declare, the zone is a hole only where no zone
 *    that declares the layer lies over it (zonaSenzaLoStrato), and the band of
 *    the board's edge clearance runs only along the stretch where the rigid
 *    part ends (its `confini`): its other sides are cut edges, along the
 *    outline (whose band the pours keep already) or over another sheet;
 *  - on a layer it declares, windows, cutouts and the flexible edge clearance
 *    along its cut edges as before, the cut edges measured among the sheets.
 */
function ostacoliFraStrati(circuitJson: El[], zone: FlexDelFile["zone"], bordoMm: number, bordoFlessibileMm: number): (strato: string) => Array<Record<string, unknown>> {
  const sopra = flessibileDellaScheda([
    ...circuitJson.filter((el) => el?.type === "pcb_board" || (el?.type === "pcb_cutout" && !eDelFlessibile(el))),
    ...zone.map((z) => ({ type: ZONA_FLESSIBILE, pcb_flex_zone_id: `z${z.indice}`, layers: z.strati, points: z.punti, flex_layer: z.flessibile ?? "" })),
  ]);
  const lati = new Map((sopra?.zone ?? []).map((z) => [z.id, z]));
  const antiorario = (punti: Punto[]) => (areaConSegno(punti) < 0 ? [...punti].reverse() : punti);
  const taglio = Math.max(bordoMm, bordoFlessibileMm);
  return (strato) => {
    const fuori: Array<Record<string, unknown>> = [];
    const buco = (id: string, punti: Punto[], margineMm: number) => {
      const p = antiorario(punti);
      fuori.push({
        shape: "polygon",
        padId: id,
        layer: strato,
        connectivityKey: `unconnected:${id}`,
        points: p,
        ...(margineMm > 0 ? { formaEsatta: { tipo: "poligono", punti: p }, margineMm } : {}),
      });
    };
    const capsule = (id: string, segmenti: Lato[], r: number) => {
      segmenti.forEach((l, k) => {
        if (Math.hypot(l.bx - l.ax, l.by - l.ay) < 1e-9) return;
        fuori.push({ shape: "polygon", padId: `${id}_${k}`, layer: strato, connectivityKey: `unconnected:${id}_${k}`, points: capsula({ x: l.ax, y: l.ay }, { x: l.bx, y: l.by }, r) });
      });
    };
    for (const z of zone) {
      const suoi = lati.get(`z${z.indice}`);
      if (!z.strati.includes(strato)) {
        zonaSenzaLoStrato(z, strato, zone).forEach((pezzo, k) => buco(`flessibile_${z.indice}_${k}`, pezzo, 0));
        if (bordoMm > 0 && suoi) capsule(`flessibile_${z.indice}_confine`, suoi.confini, bordoMm);
        continue;
      }
      z.finestre.forEach((f, k) => buco(`flessibile_${z.indice}_finestra_${k}`, f.punti, 0));
      z.ritagli.forEach((r, k) => buco(`flessibile_${z.indice}_ritaglio_${k}`, r.punti, taglio));
      // the cut edges of the zone (its own cutouts are above): along the outline the board's band holds already, but not over another sheet
      if (suoi) {
        const daiRitagli = new Set(z.ritagli.flatMap((r) => latiDi(r.punti)).map((l) => `${l.ax},${l.ay},${l.bx},${l.by}`));
        const bordi = suoi.bordi.filter((l) => !daiRitagli.has(`${l.ax},${l.ay},${l.bx},${l.by}`));
        if (taglio > 0) capsule(`flessibile_${z.indice}_bordo`, bordi, taglio);
      }
    }
    return fuori;
  };
}

// ---------------------------------------------------------------------------
// THE GERBER
// ---------------------------------------------------------------------------

/** the layers of the Gerber the flexible zones change, as circuit-json-to-gerber names them */
export const STRATI_SENZA_FLESSIBILE = ["F_Mask", "B_Mask", "F_SilkScreen", "B_SilkScreen"] as const;

/**
 * THE CIRCUIT THE MASK AND THE SILKSCREEN ARE WRITTEN FROM, on a rigid-flex
 * board: every flexible zone as a polygon pad of each face, which
 * circuit-json-to-gerber opens in the mask as a region (no liquid mask on the
 * flexible part: coverlay), and without the silkscreen drawings that enter a
 * zone. Only the layers of the mask and of the silkscreen are taken from it:
 * its copper is not the board's. null for a board with no zone.
 */
export function circuitoSenzaFlessibile<T extends El>(circuitJson: T[]): T[] | null {
  const flex = flessibileDellaScheda(circuitJson);
  if (!flex) return null;
  const via = new Set<El>(serigrafiaNelFlessibile(circuitJson, flex));
  const out = circuitJson.filter((el) => !via.has(el));
  for (const z of flex.zone) {
    for (const lato of LATI) {
      out.push({
        type: "pcb_smtpad",
        pcb_smtpad_id: `flessibile_${z.id}_${lato}`,
        shape: "polygon",
        layer: lato,
        points: z.punti,
        port_hints: [],
        is_covered_with_solder_mask: false,
      } as unknown as T);
    }
  }
  return out;
}

/**
 * The Gerber commands of a board, with the mask and the silkscreen of a
 * rigid-flex board written from circuitoSenzaFlessibile: every other layer
 * comes from the board as it is. `comandi` is what writes the commands of a
 * circuit (the export's, mask windows drawn by hand included), passed in so
 * the two compose. A board with no zone goes through it once, as it always did.
 */
export function comandiConIlFlessibile<C extends Record<string, unknown>>(circuitJson: El[], comandi: (circuitJson: El[]) => C): C {
  const fuori = comandi(circuitJson);
  const senza = circuitoSenzaFlessibile(circuitJson);
  if (!senza) return fuori;
  const facce = comandi(senza);
  for (const strato of STRATI_SENZA_FLESSIBILE) {
    if (strato in facce) (fuori as Record<string, unknown>)[strato] = facce[strato];
  }
  return fuori;
}

/** a coordinate of a Gerber in format 4.6, millimetres */
const c6 = (v: number) => String(Math.round(v * 1e6));
const numero = (v: number) => String(Number(v.toFixed(4)));

/** one layer of a Gerber written here: regions and strokes, dark or clear */
class StratoGerber {
  private aperture = new Map<string, number>();
  private righe: string[] = [];
  private chiara = false;
  private corrente = 0;
  constructor(
    private funzione: string,
    private commento: string,
  ) {}
  private apertura(diametro: number): number {
    const chiave = diametro.toFixed(6);
    let d = this.aperture.get(chiave);
    if (d === undefined) {
      d = 10 + this.aperture.size;
      this.aperture.set(chiave, d);
    }
    if (d !== this.corrente) {
      this.righe.push(`D${d}*`);
      this.corrente = d;
    }
    return d;
  }
  private polarita(chiara: boolean): void {
    if (chiara === this.chiara) return;
    this.righe.push(chiara ? "%LPC*%" : "%LPD*%");
    this.chiara = chiara;
  }
  /** a filled polygon: copper-like when dark, a hole in what was drawn before when clear */
  regione(punti: Punto[], chiara = false): void {
    if (punti.length < 3) return;
    this.polarita(chiara);
    this.righe.push("G36*", `X${c6(punti[0].x)}Y${c6(punti[0].y)}D02*`);
    for (let i = 1; i <= punti.length; i++) {
      const p = punti[i % punti.length];
      this.righe.push(`X${c6(p.x)}Y${c6(p.y)}D01*`);
    }
    this.righe.push("G37*");
  }
  /** a stroke along the points, closed or not, with a round pen */
  tratto(punti: Punto[], penna: number, chiuso = false): void {
    if (punti.length < 2) return;
    this.polarita(false);
    this.apertura(penna);
    this.righe.push(`X${c6(punti[0].x)}Y${c6(punti[0].y)}D02*`);
    for (let i = 1; i < punti.length + (chiuso ? 1 : 0); i++) {
      const p = punti[i % punti.length];
      this.righe.push(`X${c6(p.x)}Y${c6(p.y)}D01*`);
    }
  }
  /** a dashed stroke from a to b */
  tratteggio(a: Punto, b: Punto, penna: number, pieno: number, vuoto: number): void {
    const lungo = Math.hypot(b.x - a.x, b.y - a.y);
    if (lungo < 1e-9) return;
    const ux = (b.x - a.x) / lungo;
    const uy = (b.y - a.y) / lungo;
    for (let s = 0; s < lungo; s += pieno + vuoto) {
      const fine = Math.min(lungo, s + pieno);
      this.tratto([{ x: a.x + ux * s, y: a.y + uy * s }, { x: a.x + ux * fine, y: a.y + uy * fine }], penna);
    }
  }
  /** a round hole in what was drawn before */
  foro(x: number, y: number, diametro: number): void {
    this.polarita(true);
    this.apertura(diametro);
    this.righe.push(`X${c6(x)}Y${c6(y)}D03*`);
  }
  testo(): string {
    return [
      `G04 PCB Studio, rigid-flex: ${this.commento}*`,
      "%TF.GenerationSoftware,PCB Studio,rigid-flex*%",
      "%TF.SameCoordinates,Original*%",
      `%TF.FileFunction,Other,${this.funzione}*%`,
      "%TF.FilePolarity,Positive*%",
      "%FSLAX46Y46*%",
      "%MOMM*%",
      "G04 Gerber Fmt 4.6, Leading zero omitted, Abs format (unit mm)*",
      ...[...this.aperture.entries()].map(([d, n]) => `%ADD${n}C,${d}*%`),
      "G01*",
      "G75*",
      "%LPD*%",
      ...this.righe,
      "M02*",
      "",
    ].join("\n");
  }
}

/** the outline of a copper shape, as points: arcs within two micrometres */
function contornoDellaForma(f: FormaRame): Punto[] {
  if (f.tipo === "cerchio") return cerchio(f.x, f.y, f.r);
  if (f.tipo === "capsula") return capsula({ x: f.capsula.ax, y: f.capsula.ay }, { x: f.capsula.bx, y: f.capsula.by }, f.capsula.r);
  if (f.punti && f.punti.length >= 3) return f.punti;
  return rettangoloArrotondato(f.x, f.y, f.w, f.h, 0, f.rot ?? 0);
}

/** the pen of the outlines of the zones and of the bend lines on the mechanical layer (mm) */
const PENNA_ZONA_MM = 0.1;
const PENNA_PIEGA_MM = 0.2;
/** a bend line is dashed: this much drawn, this much not (mm) */
const TRATTO_PIEGA_MM = { pieno: 2, vuoto: 1 };
/** the outline of a window without copper is dotted: this much drawn and this much not (mm) */
const PUNTINI_FINESTRA_MM = 0.5;

export const FILE_MECCANICO = "Mech_RigidFlex.gbr";
export const FILE_COVERLAY: Record<Faccia, string> = { top: "F_Coverlay.gbr", bottom: "B_Coverlay.gbr" };
export const FILE_IRRIGIDITORI: Record<Faccia, string> = { top: "F_Stiffener.gbr", bottom: "B_Stiffener.gbr" };
export const FILE_PILA = "RigidFlex_Stackup.txt";
/** on independent flexible layers, the files of the k-th sheet (1, 2, ...): its profile (where it is cut) and its coverlay per face */
export const fileDelloStrato = (k: number) => ({
  profilo: `Flex${k}_Profile.gbr`,
  coverlay: { top: `Flex${k}_F_Coverlay.gbr`, bottom: `Flex${k}_B_Coverlay.gbr` } as Record<Faccia, string>,
});

const area = (p: Punto[]) => Math.abs(areaConSegno(p));
const scatola = (p: Punto[]) => {
  const xs = p.map((q) => q.x);
  const ys = p.map((q) => q.y);
  return `x ${numero(Math.min(...xs))} to ${numero(Math.max(...xs))}, y ${numero(Math.min(...ys))} to ${numero(Math.max(...ys))}`;
};
const coordinate = (p: Punto[]) => p.map((q) => `(${numero(q.x)}, ${numero(q.y)})`).join(" ");
/** a name as it goes in the text for the fab: the ones the file may carry, and nothing else */
const scritto = (nome: string) => (NOME.test(nome) ? nome : "-");

/** the sheets of a board with independent flexible layers, numbered from 1 in the order of the stack, each with its zones: empty on a board with one flexible part */
export function fogliDelFlessibile(flex: Flessibile): Array<{ numero: number; strato: StratoFlessibile; zone: Flessibile["zone"] }> {
  return (flex.pila?.flessibili ?? []).map((strato, i) => ({ numero: i + 1, strato, zone: flex.zone.filter((z) => z.flessibile === strato.nome) }));
}

/**
 * THE FILES A RIGID-FLEX BOARD ADDS TO ITS GERBER PACKAGE, by name: empty for
 * a board with no flexible zone.
 *
 *  - Mech_RigidFlex.gbr: the outline of every zone (a continuous line), of its
 *    windows without copper (dotted) and the bend lines (dashed). Not copper
 *    and not a cut: the cutouts of a zone are on Edge_Cuts, with the outline;
 *  - F_Coverlay.gbr, B_Coverlay.gbr: the coverlay of each face, POSITIVE: dark
 *    where there is coverlay (the zones), clear where it is open (the openings
 *    of the file, the mask opening of every SMD pad of that face in a zone,
 *    and the cutouts);
 *  - F_Stiffener.gbr, B_Stiffener.gbr: the stiffeners of a face, dark, with
 *    their holes clear; only for a face that has one;
 *  - RigidFlex_Stackup.txt: the stack of the rigid part and of the flexible
 *    one, the zones, the bends and the stiffeners, in English, for the fab.
 *
 * Nothing in the text but numbers, the names the file passed (NOME) and what
 * the project declares for its own stackup, already checked (resolveStackup).
 */
export function fileDelFlessibile(circuitJson: unknown[], fsMap: Record<string, string>, progetto: string): Record<string, string> {
  const els = circuitJson as El[];
  const flex = flessibileDellaScheda(els);
  if (!flex) return {};
  const fuori: Record<string, string> = {};

  const meccanico = new StratoGerber("RigidFlexZones", "flexible zones (solid line), copper-free windows (dotted line) and bend lines (dashed line). Not copper, not a cut");
  for (const z of flex.zone) {
    meccanico.tratto(z.punti, PENNA_ZONA_MM, true);
    for (const f of z.finestre) {
      latiDi(f.punti).forEach((l) => meccanico.tratteggio({ x: l.ax, y: l.ay }, { x: l.bx, y: l.by }, PENNA_ZONA_MM, PUNTINI_FINESTRA_MM, PUNTINI_FINESTRA_MM));
    }
  }
  for (const p of flex.pieghe) meccanico.tratteggio(p.a, p.b, PENNA_PIEGA_MM, TRATTO_PIEGA_MM.pieno, TRATTO_PIEGA_MM.vuoto);
  fuori[FILE_MECCANICO] = meccanico.testo();
  // independent flexible layers: the profile of each sheet, where the fab cuts it (its zones and their cutouts) and where it bends
  for (const f of fogliDelFlessibile(flex)) {
    const profilo = new StratoGerber(
      `Profile,Flex${f.numero}`,
      `profile of flexible layer ${f.numero} "${scritto(f.strato.nome)}": cut outline of its zones and of their cutouts (solid line), bend lines (dashed line). Cut this sheet along it; not bonded to the other flexible layers outside the rigid part (air gap)`,
    );
    for (const z of f.zone) {
      profilo.tratto(z.punti, PENNA_ZONA_MM, true);
      for (const r of z.ritagli) profilo.tratto(r.punti, PENNA_ZONA_MM, true);
    }
    for (const p of flex.pieghe) if (p.zona && f.zone.includes(p.zona)) profilo.tratteggio(p.a, p.b, PENNA_PIEGA_MM, TRATTO_PIEGA_MM.pieno, TRATTO_PIEGA_MM.vuoto);
    fuori[fileDelloStrato(f.numero).profilo] = profilo.testo();
  }

  /** the openings of the coverlay the pads of a face ask for: their mask opening, when the pad is in a zone */
  const apertureDeiPad = (lato: Faccia): Punto[][] => {
    const out: Punto[][] = [];
    for (const el of els) {
      if (el.type !== "pcb_smtpad" || el.layer !== lato) continue;
      const a = aperturaDelPad(el);
      if (!a) continue;
      const f = a.forma as { x: number; y: number };
      if (!zonaDelPunto(flex, f.x, f.y)) continue;
      out.push(contornoDellaForma(a.forma));
    }
    return out;
  };
  const aperteDaiPad: Record<Faccia, number> = { top: 0, bottom: 0 };
  // independent flexible layers: every sheet has its own profile and its own coverlay (fogliDelFlessibile)
  const fogli = fogliDelFlessibile(flex);
  for (const lato of LATI) {
    if (fogli.length === 0) {
      const coverlay = new StratoGerber(`Coverlay,${lato === "top" ? "Top" : "Bot"}`, `coverlay, ${lato} side. POSITIVE: dark = coverlay, clear = opening in the coverlay`);
      for (const z of flex.zone) coverlay.regione(z.punti);
      // no coverlay over a hole cut through the tail
      for (const z of flex.zone) for (const r of z.ritagli) coverlay.regione(r.punti, true);
      for (const a of flex.aperture) if (a.lato === lato) coverlay.regione(a.punti, true);
      const deiPad = apertureDeiPad(lato);
      aperteDaiPad[lato] = deiPad.length;
      for (const p of deiPad) coverlay.regione(p, true);
      fuori[FILE_COVERLAY[lato]] = coverlay.testo();
    } else {
      for (const f of fogli) {
        const nomi = fileDelloStrato(f.numero);
        const coverlay = new StratoGerber(
          `Coverlay,${lato === "top" ? "Top" : "Bot"},Flex${f.numero}`,
          `coverlay of flexible layer ${f.numero} "${scritto(f.strato.nome)}", ${lato} side. POSITIVE: dark = coverlay, clear = opening in the coverlay`,
        );
        const ids = new Set(f.zone.map((z) => z.id));
        for (const z of f.zone) coverlay.regione(z.punti);
        for (const z of f.zone) for (const r of z.ritagli) coverlay.regione(r.punti, true);
        for (const a of flex.aperture) if (a.lato === lato && a.zonaId && ids.has(a.zonaId)) coverlay.regione(a.punti, true);
        // the pads of this face in a zone of this sheet: a pad is on the sheet that has its copper layer
        const deiPad = apertureDeiPad(lato).filter((p) => {
          const c = { x: p.reduce((t, q) => t + q.x, 0) / p.length, y: p.reduce((t, q) => t + q.y, 0) / p.length };
          return f.zone.some((z) => z.strati.includes(lato) && profondita(c.x, c.y, z.punti) > 0);
        });
        aperteDaiPad[lato] += deiPad.length;
        for (const p of deiPad) coverlay.regione(p, true);
        fuori[nomi.coverlay[lato]] = coverlay.testo();
      }
    }
    const suoi = flex.irrigiditori.filter((r) => r.lato === lato);
    if (suoi.length === 0) continue;
    const irrigiditori = new StratoGerber(`Stiffener,${lato === "top" ? "Top" : "Bot"}`, `stiffeners, ${lato} side. POSITIVE: dark = stiffener, clear = hole through it`);
    for (const r of suoi) irrigiditori.regione(r.punti);
    for (const r of suoi) for (const f of r.fori) irrigiditori.foro(f.x, f.y, f.diametroMm);
    fuori[FILE_IRRIGIDITORI[lato]] = irrigiditori.testo();
  }

  // --- the text for the fab
  const board = els.find((e) => e?.type === "pcb_board");
  const stratiScheda = stratiDiRame(typeof board?.num_layers === "number" ? board.num_layers : 2);
  const spessoreScheda = typeof board?.thickness === "number" && Number.isFinite(board.thickness) ? board.thickness : null;
  const t: string[] = [];
  t.push("RIGID-FLEX BOARD: STACK-UP, FLEXIBLE ZONES AND BEND NOTES");
  t.push(`Project: ${/^[\w.-]{1,80}$/.test(progetto) ? progetto : "-"}`);
  t.push("Written by PCB Studio from the project's flex.json. All dimensions in millimetres. Coordinates are those of the Gerber files (same origin), seen from the top side.");
  t.push("");
  t.push("1. FILES OF THIS PACKAGE THAT DESCRIBE THE FLEXIBLE PART");
  if (fogli.length === 0) t.push("  Edge_Cuts.gbr        ONE outline for the whole piece: the rigid part and the flexible zones together, and the cutouts through the flexible zones.");
  else {
    t.push(
      `  Edge_Cuts.gbr        The envelope of the whole piece: ALL the material, the rigid part and each of the ${fogli.length} flexible layers laid flat, overlapping; ` +
        "a gap closed between two tails is a hole of it. Each flexible layer is cut along its own profile (below).",
    );
    for (const f of fogli) {
      const nomi = fileDelloStrato(f.numero);
      t.push(`  ${nomi.profilo.padEnd(20)} Profile of flexible layer ${f.numero} "${scritto(f.strato.nome)}": where that sheet is cut (its zones and the cutouts through it, solid line) and its bend lines (dashed).`);
      t.push(`  ${nomi.coverlay.top.padEnd(20)} ${nomi.coverlay.bottom}  Coverlay of flexible layer ${f.numero}, top and bottom side. POSITIVE: dark = coverlay, clear = opening.`);
    }
  }
  t.push(
    `  ${FILE_MECCANICO.padEnd(20)} Outline of every flexible zone (solid line, ${PENNA_ZONA_MM} mm), copper-free windows (dotted line) and bend lines (dashed line, ${PENNA_PIEGA_MM} mm). ` +
      "Reference only: not copper, not a cut.",
  );
  if (fogli.length === 0) {
    t.push(`  ${FILE_COVERLAY.top.padEnd(20)} Coverlay on the top side of the flexible zones. POSITIVE: dark = coverlay, clear = opening.`);
    t.push(`  ${FILE_COVERLAY.bottom.padEnd(20)} Coverlay on the bottom side of the flexible zones. POSITIVE: dark = coverlay, clear = opening.`);
  }
  for (const lato of LATI) {
    if (FILE_IRRIGIDITORI[lato] in fuori) t.push(`  ${FILE_IRRIGIDITORI[lato].padEnd(20)} Stiffeners glued on the ${lato} side. POSITIVE: dark = stiffener, clear = hole through the stiffener.`);
  }
  t.push("  F_Mask.gbr, B_Mask.gbr  The flexible zones are drawn OPEN: no liquid solder mask on the flexible part, coverlay instead.");
  t.push("  F_SilkScreen.gbr, B_SilkScreen.gbr  No silkscreen in the flexible zones.");
  t.push("  The coverlay is drawn to the rigid-flex boundary: please extend it into the rigid part by your standard overlap.");
  t.push("");
  t.push("2. RIGID PART");
  t.push(`  Copper layers: ${stratiScheda.length} (${stratiScheda.map(nomeDelloStrato).join(", ")})`);
  if (spessoreScheda !== null) t.push(`  Finished thickness: ${numero(spessoreScheda)} mm`);
  const dichiarato = resolveStackup(fsMap).stackup;
  if (dichiarato && dichiarato.copperMm.length === stratiScheda.length) {
    t.push("  Stack-up, top to bottom:");
    dichiarato.copperMm.forEach((rame, i) => {
      t.push(`    ${nomeDelloStrato(stratiScheda[i]).padEnd(10)} copper      ${numero(rame)} mm`);
      const d = dichiarato.dielectrics[i];
      if (d) t.push(`    ${"".padEnd(10)} ${(d.kind ?? "dielectric").padEnd(11)} ${numero(d.mm)} mm${d.name ? `  ${d.name}` : ""}${d.er ? `  (er ${numero(d.er)})` : ""}`);
    });
  } else {
    t.push("  Stack-up: not declared in the project (design-rules.json has no \"stackup\"): fabricator's standard for this thickness.");
  }
  t.push("");
  t.push(fogli.length === 0 ? "3. FLEXIBLE PART" : `3. FLEXIBLE PART: ${fogli.length} INDEPENDENT FLEXIBLE LAYERS (AIR GAP)`);
  if (fogli.length > 0) {
    t.push(
      `  The ${fogli.length} flexible layers are bonded together and to the rigid layers ONLY inside the rigid part. Outside it they are NOT bonded to each other ` +
        "(air gap, no adhesive between them): each tail bends on its own. Flat, their outlines overlap: each is cut along its own profile.",
    );
    for (const f of fogli) {
      t.push(`  Flexible layer ${f.numero} "${scritto(f.strato.nome)}": copper layers of the board that continue in it: ${f.strato.strati.map(nomeDelloStrato).join(", ")} (${f.strato.strati.length}).`);
      t.push(`    Thickness: ${numero(f.strato.spessoreMm)} mm (coverlay included, stiffeners not included); coverlay: ${voce(COVERLAY, f.strato.coverlay) ?? "-"}`);
      f.strato.materiali.forEach((m, i) => {
        t.push(`    ${String(i + 1).padStart(2)}. ${(voce(TIPI_DI_MATERIALE, m.tipo) ?? "other").padEnd(10)} ${numero(m.mm)} mm${m.nome ? `  ${scritto(m.nome)}` : ""}`);
      });
      t.push(`    Zones: ${f.zone.map((z) => `"${scritto(z.nome)}"`).join(", ") || "none"}`);
    }
  } else if (flex.pila) {
    t.push(`  Thickness: ${numero(flex.pila.spessoreMm)} mm (coverlay included, stiffeners not included)`);
    t.push(`  Coverlay: ${voce(COVERLAY, flex.pila.coverlay) ?? "-"}`);
    if (flex.pila.materiali.length > 0) {
      t.push("  Stack-up, top to bottom:");
      flex.pila.materiali.forEach((m, i) => {
        t.push(`    ${String(i + 1).padStart(2)}. ${(voce(TIPI_DI_MATERIALE, m.tipo) ?? "other").padEnd(10)} ${numero(m.mm)} mm${m.nome ? `  ${scritto(m.nome)}` : ""}`);
      });
    }
  } else {
    t.push("  Stack-up: not declared.");
  }
  t.push("  Base material: polyimide. No plated through holes and no vias in the flexible zones.");
  flex.zone.forEach((z, i) => {
    t.push(
      `  Zone ${i + 1} "${scritto(z.nome)}"${z.flessibile ? ` (flexible layer ${fogli.findIndex((f) => f.strato.nome === z.flessibile) + 1})` : ""}: copper layers of the board that continue in the zone: ` +
        `${z.strati.map(nomeDelloStrato).join(", ") || "none"} (${z.strati.length}). Every other layer ends at the rigid-flex boundary.`,
    );
    t.push(`    Extent: ${scatola(z.punti)}; area ${numero(area(z.punti))} mm2`);
    t.push(`    Outline: ${coordinate(z.punti)}`);
    for (const l of z.confini) t.push(`    Rigid-flex boundary: from (${numero(l.ax)}, ${numero(l.ay)}) to (${numero(l.bx)}, ${numero(l.by)})`);
    if (z.retino && (z.retino.aperture ?? 0) > 0) {
      t.push(
        `    Copper: cross-hatched (grid), not solid, ${z.retino.dove === "tutta" ? "in the whole zone" : `in the bend area and ${numero(z.retino.margineMm)} mm beyond it on each side; solid elsewhere`}. ` +
          `Lines ${numero(z.retino.larghezzaMm)} mm wide, pitch ${numero(z.retino.passoMm)} mm, at ${numero(z.retino.angolo)} degrees (${z.retino.aperture} openings). It is drawn in the copper layers as it is to be made.`,
      );
    }
    for (const f of z.finestre) t.push(`    Copper-free window "${scritto(f.nome)}" (no copper on any layer, base material and coverlay stay): ${scatola(f.punti)}; outline ${coordinate(f.punti)}`);
    for (const r of z.ritagli) {
      const dove = z.flessibile ? `through this flexible layer only, on ${fileDelloStrato(fogli.findIndex((f) => f.strato.nome === z.flessibile) + 1).profilo}` : "cut through the flexible part, on Edge_Cuts.gbr";
      t.push(`    Cutout "${scritto(r.nome)}" (${dove}): ${scatola(r.punti)}; outline ${coordinate(r.punti)}`);
    }
  });
  for (const lato of LATI) {
    const sue = flex.aperture.filter((a) => a.lato === lato);
    if (sue.length === 0 && aperteDaiPad[lato] === 0) continue;
    t.push(`  Coverlay openings, ${lato} side: ${sue.length} drawn in the project, ${aperteDaiPad[lato]} for the SMD pads of the zone (pad plus its solder mask margin).`);
    for (const a of sue) t.push(`    "${scritto(a.nome)}": ${scatola(a.punti)}`);
  }
  t.push("");
  t.push("4. BEND LINES");
  if (flex.pieghe.length === 0) t.push("  None declared.");
  for (const p of flex.pieghe) {
    t.push(
      `  "${scritto(p.nome)}"${p.zona ? ` (zone "${scritto(p.zona.nome)}")` : ""}: from (${numero(p.a.x)}, ${numero(p.a.y)}) to (${numero(p.b.x)}, ${numero(p.b.y)}); ` +
        `inner bend radius ${numero(p.raggioMm)} mm; angle ${numero(p.angolo)} degrees${p.angolo >= 179.5 ? " (folded back over the board)" : ""}; ` +
        `the part beyond the line folds towards the ${p.verso === "su" ? "TOP" : "BOTTOM"} side (${p.verso === "su" ? "top" : "bottom"} side inside the bend). ` +
        `Bend area: ${numero(2 * p.mezzaFasciaMm)} mm of tail, centred on the line (arc length on the middle of the thickness).`,
    );
  }
  t.push("");
  t.push("5. STIFFENERS");
  if (flex.irrigiditori.length === 0) t.push("  None.");
  for (const r of flex.irrigiditori) {
    const suaZona = r.zonaId ? flex.zone.find((z) => z.id === r.zonaId) : undefined;
    t.push(
      `  "${scritto(r.nome)}": ${r.lato} side${suaZona ? ` of zone "${scritto(suaZona.nome)}"` : ""}, ${voce(MATERIALI_IRRIGIDITORE, r.materiale)?.nome ?? "-"}, ${numero(r.spessoreMm)} mm thick; ` +
        `extent ${scatola(r.punti)}; area ${numero(area(r.punti))} mm2`,
    );
    t.push(`    Outline: ${coordinate(r.punti)}`);
    if (r.fori.length > 0) t.push(`    Holes through the stiffener: ${r.fori.map((f) => `d ${numero(f.diametroMm)} at (${numero(f.x)}, ${numero(f.y)})`).join("; ")}`);
  }
  t.push("");
  fuori[FILE_PILA] = t.join("\n");
  return fuori;
}
