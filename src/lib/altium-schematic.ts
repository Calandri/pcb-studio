/**
 * THE DRAWING, not just the board: what the .SchDoc files know about how the
 * circuit was DRAWN.
 *
 * An imported board arrives with ninety-eight components and no schematic: the
 * layout is left to tscircuit, which packs symbols wherever they fit and comes
 * out with one sheet of thirty-nine crossing wires and a wall of net labels
 * around the microcontroller. Measured on BAT_BS, that is what "disordinato"
 * means in numbers.
 *
 * The file already contains the two things that fix it, and a person put them
 * there:
 *
 *   1. THE SHEETS. Seven of them — the MCU, its power, the PSRAM, the SD card,
 *      the microphones — each a functional block. They become tscircuit
 *      SECTIONS (`schSectionName` plus a `<schematicsection>` frame), which is
 *      exactly the same idea: pack each block on its own, then tile the blocks.
 *      Crossings on BAT_BS: 39 down to 7.
 *
 *   2. THE SYMBOLS. Which side of the box each pin comes out of, and in what
 *      order. tscircuit defaults to half the pins left and half right, in pin
 *      number order, which on a 64 pin part is a column of sixty-four labels;
 *      the designer had already decided that the resets go on the left and the
 *      SPI on the right. That becomes `schPinArrangement`, and it is the
 *      difference between a wiring list and a schematic.
 *
 * WHY THE RAW RECORDS. The toolkit's parsed `schematic.pins` only hands over the
 * pins of the part being DISPLAYED: a multi-part component (U1 is drawn as I/O
 * on one sheet and power on another) loses the pins of its other part, 48 of 64
 * on this board. The raw records carry all of them with their `OwnerPartId`, so
 * the two halves can be put back together into the one symbol tscircuit draws.
 *
 * Nothing here decides layout: it reads what the source file says and hands it
 * over. The tiling is tscircuit's, as it should be.
 */

export interface LatiDelSimbolo {
  sinistra: string[];
  destra: string[];
  su: string[];
  giu: string[];
}

export interface VoceSchematica {
  /** the section a component belongs to: the sheet it was drawn on */
  sezione?: string;
  /** the sides of its symbol, when the sheet drew one worth reproducing */
  lati?: LatiDelSimbolo;
}

export interface LetturaSchematica {
  /** per board designator: section and symbol */
  perComponente: Map<string, VoceSchematica>;
  /** the sections in drawing order, with the name a person reads */
  sezioni: Array<{ nome: string; titolo: string }>;
}

/** one schematic file as the parser hands it over */
export interface FoglioAltium {
  path: string;
  native: Record<string, unknown>;
}

/**
 * Bit 0-1 of PinConglomerate: the direction the pin leaves the body in, which is
 * the side of the symbol it sits on.
 */
const LATO = ["destra", "su", "sinistra", "giu"] as const;

const VUOTO = (): LatiDelSimbolo => ({ sinistra: [], destra: [], su: [], giu: [] });

const contaPin = (l: LatiDelSimbolo): number =>
  l.sinistra.length + l.destra.length + l.su.length + l.giu.length;

/**
 * Under this many pins the arrangement is not worth writing: a resistor, a
 * capacitor, a two pin diode already have a symbol of their own and forcing a
 * box on them would make the drawing worse, not better.
 */
export const MIN_PIN_PER_DISPORRE = 5;

interface Record_ {
  recordIndex?: number;
  fields?: Record<string, string>;
}

const records = (native: Record<string, unknown>): Record_[] => {
  const sch = native.schematic as Record<string, unknown> | undefined;
  const own = sch?.ownership as Record<string, unknown> | undefined;
  return Array.isArray(own?.records) ? (own.records as Record_[]) : [];
};

/** the sheet name as a section identifier: lowercase, no punctuation */
const chiaveFoglio = (path: string): string =>
  path
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "foglio";

/** the same, as a person wrote it */
const titoloFoglio = (path: string): string =>
  path.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");

/**
 * One schematic sheet: which components it draws, and how it draws them.
 *
 * The designator lives in its own record (type 34) pointing at the component
 * through `OwnerIndex`, which is the component record's index MINUS ONE — the
 * file numbers its records from one and refers to them from zero. Reading it as
 * the plain index puts every pin on the wrong part.
 */
function leggiFoglio(foglio: FoglioAltium): Map<string, LatiDelSimbolo> {
  const rec = records(foglio.native);
  const designator = new Map<string, string>();
  const parteMostrata = new Map<string, string>();
  for (const r of rec) {
    const f = r.fields;
    if (!f) continue;
    if (f.RECORD === "34" && f.OwnerIndex) designator.set(String(f.OwnerIndex), String(f.Text ?? ""));
    if (f.RECORD === "1" && typeof r.recordIndex === "number") {
      parteMostrata.set(String(r.recordIndex - 1), String(f.CurrentPartId ?? "1"));
    }
  }

  const pinPerComponente = new Map<string, Array<Record<string, string>>>();
  for (const r of rec) {
    const f = r.fields;
    if (!f || f.RECORD !== "2" || !f.OwnerIndex) continue;
    const owner = String(f.OwnerIndex);
    /*
     * Only the part this sheet actually shows. A component drawn in two parts
     * carries the pins of both, and taking them all would put a pin on the left
     * because the OTHER half draws it there.
     */
    if (String(f.OwnerPartId ?? "1") !== (parteMostrata.get(owner) ?? "1")) continue;
    if (!pinPerComponente.has(owner)) pinPerComponente.set(owner, []);
    pinPerComponente.get(owner)!.push(f);
  }

  const out = new Map<string, LatiDelSimbolo>();
  for (const [owner, pins] of pinPerComponente) {
    const nome = designator.get(owner);
    if (!nome) continue;
    const lati = out.get(nome) ?? VUOTO();
    for (const lato of LATO) {
      const suQuestoLato = pins.filter(
        (p) => LATO[Number(p.PinConglomerate ?? 0) & 3] === lato,
      );
      // down the vertical sides, left to right along the horizontal ones: the
      // order a person reads them in
      suQuestoLato.sort((a, b) =>
        lato === "sinistra" || lato === "destra"
          ? Number(b["Location.Y"] ?? 0) - Number(a["Location.Y"] ?? 0)
          : Number(a["Location.X"] ?? 0) - Number(b["Location.X"] ?? 0),
      );
      for (const p of suQuestoLato) {
        const pin = String(p.Designator ?? "").trim();
        if (!pin) continue;
        // a pin is named once: the two halves of a multi-part component can put
        // the same one on opposite sides
        if (LATO.some((l) => lati[l].includes(pin))) continue;
        lati[lato].push(pin);
      }
    }
    out.set(nome, lati);
  }
  return out;
}

/**
 * Reads every schematic sheet of a project and works out, for each component of
 * the BOARD, which section it belongs to and how its symbol is drawn.
 *
 * `designator` is the board's list of names: it is what decides the answer,
 * because a sheet can be instantiated more than once (the microphone sheet is,
 * twice) and the board is where the copies get their names — MIC_1 and MIC_2 for
 * the sheet's MIC. Each instance becomes its own section, which is what the
 * designer drew: two identical channels, side by side.
 */
export function schematicaNativa(
  fogli: FoglioAltium[],
  designator: Iterable<string>,
): LetturaSchematica {
  const nomi = new Set(designator);
  const perComponente = new Map<string, VoceSchematica>();
  const sezioni: Array<{ nome: string; titolo: string }> = [];
  const vistoSezione = new Set<string>();

  for (const foglio of fogli) {
    const simboli = leggiFoglio(foglio);
    if (simboli.size === 0) continue;
    const chiave = chiaveFoglio(foglio.path);
    const titolo = titoloFoglio(foglio.path);

    /*
     * WHICH COPIES OF THIS SHEET THE BOARD CARRIES. A sheet placed twice gives
     * the board MIC_1 and MIC_2 where the sheet says MIC; a sheet placed once
     * gives it plain names. The suffixes are read off the board, so an import
     * never invents a component that is not there.
     */
    const suffissi = new Set<string>();
    for (const base of simboli.keys()) {
      if (nomi.has(base)) suffissi.add("");
      for (const nome of nomi) {
        if (!nome.startsWith(`${base}_`)) continue;
        const suffisso = nome.slice(base.length);
        if (/^_\d+$/.test(suffisso)) suffissi.add(suffisso);
      }
    }

    for (const suffisso of [...suffissi].sort()) {
      const sezione = suffisso ? `${chiave}${suffisso.replace("_", "-")}` : chiave;
      let usata = false;
      for (const [base, lati] of simboli) {
        const nome = `${base}${suffisso}`;
        if (!nomi.has(nome)) continue;
        usata = true;
        const voce = perComponente.get(nome) ?? {};
        // the first sheet that draws a component wins: a part shown on two
        // sheets (a multi-part MCU) belongs to the block it was drawn in first
        voce.sezione ??= sezione;
        if (!voce.lati || contaPin(voce.lati) < contaPin(lati)) voce.lati = lati;
        perComponente.set(nome, voce);
      }
      if (usata && !vistoSezione.has(sezione)) {
        vistoSezione.add(sezione);
        sezioni.push({
          nome: sezione,
          titolo: suffisso ? `${titolo} (${suffisso.slice(1)})` : titolo,
        });
      }
    }
  }

  /*
   * Whatever the sheets do not mention — a part added straight on the board, a
   * fiducial, a mounting hole — still needs a section: a component without one
   * falls into an unnamed leftover block that tscircuit draws on top of the
   * others.
   */
  const orfani = [...nomi].filter((n) => !perComponente.get(n)?.sezione);
  if (orfani.length > 0) {
    for (const nome of orfani) {
      perComponente.set(nome, { ...perComponente.get(nome), sezione: "altro" });
    }
    sezioni.push({ nome: "altro", titolo: "Altro" });
  }

  return { perComponente, sezioni };
}

/**
 * The pin arrangement as a JS object literal, ready to go inside a JSX
 * expression, or null when the symbol is not worth reproducing (too few pins:
 * the default symbol is better).
 */
export function disposizionePin(lati: LatiDelSimbolo | undefined): string | null {
  if (!lati || contaPin(lati) < MIN_PIN_PER_DISPORRE) return null;
  const lato = (pins: string[], nome: string, verticale: boolean): string | null =>
    pins.length
      ? `${nome}: { pins: [${pins.map((p) => JSON.stringify(p)).join(", ")}], direction: "${
          verticale ? "top-to-bottom" : "left-to-right"
        }" }`
      : null;
  const parti = [
    lato(lati.sinistra, "leftSide", true),
    lato(lati.destra, "rightSide", true),
    lato(lati.su, "topSide", false),
    lato(lati.giu, "bottomSide", false),
  ].filter((p): p is string => p !== null);
  return parti.length ? `{ ${parti.join(", ")} }` : null;
}
