/**
 * THE MASK OPENINGS DRAWN BY HAND (maschera.json).
 *
 * The Gerber opens the mask around every pad by itself: the pad grown by its
 * soldermask_margin on every side (circuit-json-to-gerber). On a part at
 * 0.4-0.5 mm pitch that cannot satisfy the fab: PCB Basic (row 23 of its
 * capabilities, "Solder Mask Opening >= 2 mil / Bridge >= 4 mil") wants 0.0508
 * around every pad AND 0.1016 of mask between two openings, and between two
 * pins 0.2 mm apart there is no room for both. The practice is one window for
 * a whole row of pins (gang relief), 0.051 around the row, and no mask between
 * the pins of the row. On sbb-dl-principale U1 (LQFP64, pitch 0.5) needs four
 * of them, FL1 (EMIF06, pitch 0.4) two, with its ground pad in the middle left
 * with its own opening and the mask between it and the rows.
 *
 * Such windows are written in a project file, like the paste openings of
 * stencil.json, but in BOARD coordinates (mm, centre of the board = 0,0, y up,
 * seen from the top on both faces), per face, each tied to a part by name:
 *
 *   { "top": [
 *       { "pezzo": "U1", "nome": "fila nord", "forma": "rettangolo", "x": 0, "y": 5.85, "w": 7.8, "h": 1.6 },
 *       { "pezzo": "U1", "nome": "fila est", "forma": "rettangolo", "x": 5.85, "y": 0, "w": 7.8, "h": 1.6, "rot": 90 },
 *       { "pezzo": "FL1", "nome": "fila ovest", "forma": "poligono",
 *         "punti": [{ "x": -1.1, "y": -0.9 }, { "x": -0.6, "y": -0.9 }, { "x": -0.6, "y": 0.9 }, { "x": -1.1, "y": 0.9 }] } ],
 *     "bottom": [] }
 *
 * A rectangle is its centre, its size and an optional turn in degrees,
 * counterclockwise; a polygon is its vertices, 3 to MAX_VERTICI. A pad covered
 * whole by a window opens none of its own: in the Gerber of the mask, in the
 * viewer, in the checks (apertureAMano in drc.ts). Every other pad opens as it
 * always did. Without the file nothing changes, the Gerber included, byte for
 * byte.
 *
 * On the board each window is an element of its own (APERTURA_A_MANO), put
 * there by the compile and the recheck (conMascheraAMano): the board that is
 * exported is the board that was checked.
 */
import {
  APERTURA_A_MANO,
  apertureAMano,
  bordoVicino,
  contornoScheda,
  formaDaPunti,
  TOLLERANZA_MM,
} from "./drc";

type El = Record<string, unknown> & { type: string };

export const MASCHERA_PATH = "maschera.json";

/** at most this many windows in a file, both faces together: four rows each for a hundred parts */
export const MAX_APERTURE_MASCHERA = 400;
/** at most this many vertices in one polygon */
export const MAX_VERTICI = 64;
/** a window narrower than this is a typo, not a window: the smallest opening a fab images */
const LATO_MINIMO_MM = 0.05;
/** and wider than this on a side, a typo too */
const LATO_MASSIMO_MM = 200;
/** no board is bigger: a coordinate past it is a typo, before the board is even known */
const COORDINATA_MASSIMA_MM = 1000;
const LATI = ["top", "bottom"] as const;
const CAMPI = ["pezzo", "nome", "forma", "x", "y", "w", "h", "rot", "punti"];
/** a part's name, as tscircuit writes it: U1, C_12, J4 */
const NOME_PEZZO = /^[A-Za-z_][A-Za-z0-9_.+-]{0,39}$/;
/** the name of a window: one short line of letters, digits and plain punctuation */
const NOME_APERTURA = /^[A-Za-z0-9\u00C0-\u00FF _.,:+()/-]{1,60}$/;

/** the file, for whoever writes it: the agent's write_file and the MCP's instructions */
export const DESCRIZIONE_MASCHERA =
  `${MASCHERA_PATH} draws mask openings by hand: one window for a whole row of fine-pitch pins (gang relief), for when an opening ` +
  `around every pad leaves less mask between two pins than the fab prints (minSolderMaskBridgeMm in the rules, 0.1016mm by default; ` +
  `the DRC says it as solder_mask_bridge). Board coordinates in mm (board centre 0,0, y up, as seen from the top on both faces), per face, ` +
  `each window tied to a part by name: {"top": [{"pezzo": "U1", "nome": "fila nord", "forma": "rettangolo", "x": 0, "y": 5.85, "w": 7.8, "h": 1.6, "rot": 0}, ` +
  `{"pezzo": "FL1", "nome": "fila ovest", "forma": "poligono", "punti": [{"x": -1.1, "y": -0.9}, {"x": -0.6, "y": -0.9}, {"x": -0.6, "y": 0.9}, {"x": -1.1, "y": 0.9}]}], "bottom": []}; ` +
  `rot in degrees counterclockwise, optional; a polygon has 3 to ${MAX_VERTICI} vertices and no crossing sides; at most ${MAX_APERTURE_MASCHERA} windows; ` +
  `every vertex on the board; "nome" optional, letters, digits, spaces and plain punctuation. A pad covered whole by a window opens no opening of its own ` +
  `(Gerber, viewer, checks); every other pad keeps its own, and a window touching it is a solder_mask_bridge error (keep a ground pad between two rows ` +
  `out of the windows, with mask around it). Checked whole when written: one wrong window refuses the file with the reasons. Without the file the mask is the pads' own.`;

/** one window of the file, as a polygon in board coordinates */
export interface AperturaDelFile {
  lato: "top" | "bottom";
  /** its place in the list of its face: top[3] */
  indice: number;
  pezzo: string;
  nome?: string;
  punti: Array<{ x: number; y: number }>;
}

const finito = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const arrotonda = (v: number) => Number(v.toFixed(6)) || 0;

/** the four corners of a rectangle centred on x,y, turned by rot degrees counterclockwise */
function angoli(x: number, y: number, w: number, h: number, rot: number): Array<{ x: number; y: number }> {
  const t = (rot * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([dx, dy]) => ({ x: arrotonda(x + dx * cos - dy * sin), y: arrotonda(y + dx * sin + dy * cos) }));
}

/** twice the signed area of a polygon */
function area2(p: Array<{ x: number; y: number }>): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x - p[i].x) * (p[j].y + p[i].y);
  return a;
}

/** whether two edges of a polygon that do not share a vertex cross */
function siIncrocia(p: Array<{ x: number; y: number }>): boolean {
  const n = p.length;
  const verso = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) =>
    Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
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

/** whether a point is on the board: in its outline or on its edge, within a micron */
function sullaScheda(p: { x: number; y: number }, contorno: Array<{ x: number; y: number }>): boolean {
  return bordoVicino(formaDaPunti(contorno), p.x, p.y).d <= TOLLERANZA_MM;
}

/**
 * The windows of a maschera.json, checked one by one: what is right is kept,
 * what is wrong is said in `errori` by face and place (top[3]) and left out.
 * Nothing of what was sent comes back in a message but numbers and the names
 * of the fields the file may have. `contorno`, when given, is the outline of
 * the board: a window with a vertex off it is wrong too.
 */
function validaMaschera(
  data: unknown,
  contorno?: Array<{ x: number; y: number }>,
): { aperture: AperturaDelFile[]; errori: string[] } {
  const aperture: AperturaDelFile[] = [];
  const errori: string[] = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { aperture, errori: ['serve un oggetto {"top": [...], "bottom": [...]}'] };
  }
  const obj = data as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!(LATI as readonly string[]).includes(k)) errori.push(`campo sconosciuto ${/^[A-Za-z_]\w{0,30}$/.test(k) ? k : "dal nome non valido"} (ammessi top e bottom)`);
  }
  let totale = 0;
  for (const lato of LATI) {
    const voci = obj[lato];
    if (voci === undefined) continue;
    if (!Array.isArray(voci)) {
      errori.push(`${lato}: serve un elenco di aperture`);
      continue;
    }
    totale += voci.length;
    voci.slice(0, MAX_APERTURE_MASCHERA).forEach((voce, indice) => {
      const dove = `${lato}[${indice}]`;
      if (typeof voce !== "object" || voce === null || Array.isArray(voce)) {
        errori.push(`${dove}: serve un oggetto {"pezzo": ..., "forma": ...}`);
        return;
      }
      const v = voce as Record<string, unknown>;
      const sbagliati = Object.keys(v).filter((k) => !CAMPI.includes(k));
      if (sbagliati.length > 0) {
        errori.push(`${dove}: ${sbagliati.length === 1 ? "un campo sconosciuto" : `${sbagliati.length} campi sconosciuti`} (ammessi ${CAMPI.join(", ")})`);
        return;
      }
      if (typeof v.pezzo !== "string" || !NOME_PEZZO.test(v.pezzo)) {
        errori.push(`${dove}.pezzo: serve il nome di un pezzo della scheda (U1, FL1), lettere, cifre e _ . + -, fino a 40 caratteri`);
        return;
      }
      if (v.nome !== undefined && (typeof v.nome !== "string" || !NOME_APERTURA.test(v.nome))) {
        errori.push(`${dove}.nome: un testo da 1 a 60 caratteri, lettere, cifre, spazi e _ . , : + ( ) / -`);
        return;
      }
      let punti: Array<{ x: number; y: number }>;
      if (v.forma === "rettangolo") {
        if (v.punti !== undefined) {
          errori.push(`${dove}: un rettangolo si scrive con x, y, w, h e rot, non con punti`);
          return;
        }
        if (!finito(v.x) || !finito(v.y) || Math.abs(v.x) > COORDINATA_MASSIMA_MM || Math.abs(v.y) > COORDINATA_MASSIMA_MM) {
          errori.push(`${dove}: x e y, il centro in mm sulla scheda, devono essere numeri`);
          return;
        }
        if (!finito(v.w) || !finito(v.h) || v.w < LATO_MINIMO_MM || v.h < LATO_MINIMO_MM || v.w > LATO_MASSIMO_MM || v.h > LATO_MASSIMO_MM) {
          errori.push(`${dove}: w e h, i lati in mm, devono essere numeri da ${LATO_MINIMO_MM} a ${LATO_MASSIMO_MM}`);
          return;
        }
        if (v.rot !== undefined && (!finito(v.rot) || Math.abs(v.rot) > 360)) {
          errori.push(`${dove}.rot: i gradi della rotazione, antioraria, da -360 a 360`);
          return;
        }
        punti = angoli(v.x, v.y, v.w, v.h, finito(v.rot) ? v.rot : 0);
      } else if (v.forma === "poligono") {
        if (["x", "y", "w", "h", "rot"].some((k) => v[k] !== undefined)) {
          errori.push(`${dove}: un poligono si scrive con punti, non con x, y, w, h o rot`);
          return;
        }
        const p = v.punti;
        if (!Array.isArray(p) || p.length < 3 || p.length > MAX_VERTICI) {
          errori.push(`${dove}.punti: serve un elenco da 3 a ${MAX_VERTICI} vertici {"x": ..., "y": ...}`);
          return;
        }
        const letti = p.map((q) => {
          const o = q as Record<string, unknown> | null;
          return o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every((k) => k === "x" || k === "y") &&
            finito(o.x) && finito(o.y) && Math.abs(o.x) <= COORDINATA_MASSIMA_MM && Math.abs(o.y) <= COORDINATA_MASSIMA_MM
            ? { x: arrotonda(o.x), y: arrotonda(o.y) }
            : null;
        });
        if (letti.some((q) => q === null)) {
          errori.push(`${dove}.punti: ogni vertice e' {"x": ..., "y": ...}, due numeri in mm`);
          return;
        }
        punti = letti as Array<{ x: number; y: number }>;
        if (siIncrocia(punti)) {
          errori.push(`${dove}.punti: due lati del poligono si incrociano`);
          return;
        }
        if (Math.abs(area2(punti)) / 2 < LATO_MINIMO_MM * LATO_MINIMO_MM) {
          errori.push(`${dove}.punti: il poligono non ha area`);
          return;
        }
      } else {
        errori.push(`${dove}.forma: deve essere "rettangolo" o "poligono"`);
        return;
      }
      if (contorno && contorno.length >= 3 && !punti.every((q) => sullaScheda(q, contorno))) {
        errori.push(`${dove}: esce dalla scheda`);
        return;
      }
      aperture.push({ lato, indice, pezzo: v.pezzo, ...(typeof v.nome === "string" ? { nome: v.nome } : {}), punti });
    });
  }
  if (totale > MAX_APERTURE_MASCHERA) errori.push(`troppe aperture (${totale}, massimo ${MAX_APERTURE_MASCHERA} fra top e bottom)`);
  return { aperture, errori };
}

/** reads maschera.json at compile: a broken entry is said and skipped, never guessed */
export function leggiMaschera(fsMap: Record<string, string>): { aperture: AperturaDelFile[]; avvisi: string[] } {
  const raw = fsMap[MASCHERA_PATH];
  if (raw === undefined || raw.trim() === "") return { aperture: [], avvisi: [] };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { aperture: [], avvisi: [`${MASCHERA_PATH} non e' un JSON valido: ignorato`] };
  }
  const { aperture, errori } = validaMaschera(data);
  return { aperture, avvisi: errori.map((e) => `${MASCHERA_PATH}: ${e}, saltata`) };
}

/**
 * A maschera.json written by a tool (write_file), checked WHOLE before it is
 * written: one window wrong refuses the file with every reason, nothing is
 * saved half-right. `contorno` is the outline of the board as last compiled,
 * when there is one: a window off it is refused.
 */
export function validaFileDellaMaschera(
  content: string,
  contorno?: Array<{ x: number; y: number }>,
): { aperture: AperturaDelFile[] } | { errori: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return { errori: ["non e' un JSON valido (NaN e Infinity non sono JSON)"] };
  }
  const { aperture, errori } = validaMaschera(data, contorno);
  return errori.length > 0 ? { errori } : { aperture };
}

/** the outline of a board, from its circuit: [] when it has none */
export function contornoDelCircuito(circuitJson: unknown[] | null | undefined): Array<{ x: number; y: number }> {
  const board = (circuitJson as El[] | null | undefined)?.find((e) => e?.type === "pcb_board");
  return contornoScheda(board);
}

/**
 * THE WINDOWS OF maschera.json PUT ON THE BOARD, after the paste: those of
 * the file, each as an element of its own, a polygon in board coordinates
 * (APERTURA_A_MANO); those already there, from a board of before, taken off
 * first. A window that leaves the board is not put on it (avvisiDellaMaschera
 * says so). A board with no file and no window is given back as it came.
 */
export function conMascheraAMano<T extends El>(circuitJson: T[], fsMap: Record<string, string>): T[] {
  const giaSopra = circuitJson.some((el) => el.type === APERTURA_A_MANO);
  if (fsMap[MASCHERA_PATH] === undefined && !giaSopra) return circuitJson;
  const out = circuitJson.filter((el) => el.type !== APERTURA_A_MANO);
  const contorno = contornoDelCircuito(out);
  for (const a of leggiMaschera(fsMap).aperture) {
    if (contorno.length >= 3 && !a.punti.every((p) => sullaScheda(p, contorno))) continue;
    out.push({
      type: APERTURA_A_MANO,
      pcb_soldermask_opening_id: `pcb_soldermask_opening_${a.lato}_${a.indice}`,
      layer: a.lato,
      points: a.punti,
      pezzo: a.pezzo,
      ...(a.nome ? { nome: a.nome } : {}),
    } as unknown as T);
  }
  return out;
}

/**
 * What is wrong with the windows of a board, in words, for the electrical
 * checks: an entry of the file that could not be read, a window off the board,
 * one for a part the board does not have, one that covers whole no pad of its
 * part. Empty for a project without the file.
 */
export function avvisiDellaMaschera(
  circuitJson: El[],
  fsMap: Record<string, string>,
): Array<{ message: string; x?: number; y?: number }> {
  if (fsMap[MASCHERA_PATH] === undefined) return [];
  const { aperture: delFile, avvisi } = leggiMaschera(fsMap);
  const out: Array<{ message: string; x?: number; y?: number }> = avvisi.map((message) => ({ message }));
  const centro = (punti: Array<{ x: number; y: number }>) => {
    const f = formaDaPunti(punti) as { x: number; y: number };
    return { x: f.x, y: f.y };
  };
  const nomeDi = (a: { pezzo: string; nome?: string }) => [a.pezzo, a.nome].filter(Boolean).join(" ");
  const { aperture } = apertureAMano(circuitJson);
  const sopra = new Set(aperture.map((a) => a.id));
  for (const a of delFile) {
    if (sopra.has(`pcb_soldermask_opening_${a.lato}_${a.indice}`)) continue;
    out.push({ message: `${MASCHERA_PATH}: l'apertura «${nomeDi(a)}» (${a.lato}[${a.indice}]) esce dalla scheda: non e' stata messa`, ...centro(a.punti) });
  }
  const nomeSorgente = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "source_component") nomeSorgente.set(String(el.source_component_id ?? ""), String(el.name ?? ""));
  }
  const pezzoDi = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "pcb_component") pezzoDi.set(String(el.pcb_component_id ?? ""), nomeSorgente.get(String(el.source_component_id ?? "")) ?? "");
  }
  const pezzi = new Set(pezzoDi.values());
  for (const a of aperture) {
    const dove = { x: (a.forma as { x: number }).x, y: (a.forma as { y: number }).y };
    if (!pezzi.has(a.pezzo)) {
      out.push({ message: `${MASCHERA_PATH}: l'apertura «${a.nome}» (${a.layer}) e' per ${a.pezzo}, che non e' sulla scheda`, ...dove });
    } else if (!a.coperte.some((c) => pezzoDi.get(String(c.pcb_component_id ?? "")) === a.pezzo)) {
      out.push({ message: `${MASCHERA_PATH}: l'apertura «${a.nome}» (${a.layer}) non copre per intero nessuna piazzola di ${a.pezzo}: le coordinate sono della scheda, in mm, col centro in 0,0`, ...dove });
    }
  }
  return out;
}

/**
 * THE CIRCUIT THE MASK IS WRITTEN FROM, when the board has windows drawn by
 * hand: the pads they cover taken off (they open none of their own) and every
 * window as a polygon pad of its face, which circuit-json-to-gerber opens in
 * the mask as a region. Only the layers of the mask are taken from it (see
 * strati della maschera in the export): its copper is not the board's. null
 * when the board has no window: the Gerber is written as it always was.
 */
export function circuitoPerLaMaschera<T extends El>(circuitJson: T[]): T[] | null {
  const { aperture, coperte } = apertureAMano(circuitJson);
  if (aperture.length === 0) return null;
  const out = circuitJson.filter(
    (el) =>
      el.type !== APERTURA_A_MANO &&
      !(el.type === "pcb_smtpad" && typeof el.pcb_smtpad_id === "string" && coperte.has(el.pcb_smtpad_id)),
  );
  for (const a of aperture) {
    out.push({
      type: "pcb_smtpad",
      pcb_smtpad_id: `maschera_${a.id}`,
      shape: "polygon",
      layer: a.layer,
      points: a.punti,
      port_hints: [],
      is_covered_with_solder_mask: false,
    } as unknown as T);
  }
  return out;
}

/** the layers of the Gerber that are the mask, as circuit-json-to-gerber names them */
export const STRATI_DELLA_MASCHERA = ["F_Mask", "B_Mask"] as const;

/**
 * The Gerber commands of a board, with the mask written from the windows
 * drawn by hand when it has any (circuitoPerLaMaschera): every other layer
 * comes from the board as it is. `converti` is circuit-json-to-gerber's
 * convertSoupToGerberCommands, passed in so this file stays free of it.
 */
export function comandiConLaMaschera<C extends Record<string, unknown>>(
  circuitJson: El[],
  converti: (circuitJson: El[]) => C,
): C {
  const comandi = converti(circuitJson);
  const perLaMaschera = circuitoPerLaMaschera(circuitJson);
  if (!perLaMaschera) return comandi;
  const maschera = converti(perLaMaschera);
  for (const strato of STRATI_DELLA_MASCHERA) {
    if (strato in maschera) (comandi as Record<string, unknown>)[strato] = maschera[strato];
  }
  return comandi;
}
