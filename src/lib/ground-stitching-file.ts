/**
 * THE FILE OF THE STITCHING: cucitura-massa.tsx.
 *
 * What cuciLaMassa proposes is written, when asked (apply), into one file of
 * the project that holds nothing else: a component exporting the `<via>`s,
 * each with its net, drill and ring written out, so the board's pcbStyle does
 * not decide them. A new run replaces the whole file (the same board and
 * options give the same file, byte for byte: no date in it).
 *
 * main.tsx is NEVER touched: many projects generate it from a script
 * (sbb-dl-principale: genera_tsx.py, "non modificare a mano"), and a line added
 * there would be lost at the next generation or would break it. When main.tsx
 * does not import the file, the answer says the two lines to add.
 *
 * Before measuring again, the vias the file already put on the saved board are
 * taken off it (vieDelFile, senzaLeVieAi): otherwise the second run would see
 * the first run's vias as ground already stitched and propose nothing, and the
 * file would not be the same.
 *
 * ONLY A FILE THE TOOL WROTE IS READ THAT WAY, AND ONLY SUCH A FILE IS EVER
 * REPLACED (leggiFileDellaCucitura). A cucitura-massa.tsx someone wrote by hand
 * (a signal via, a trace) was rewritten whole, losing what it held, and its
 * signal via was taken off the board as if it were a stitching via, so a ground
 * via was proposed where it stood (review of 12/11/2026). The tool's file is
 * recognised by its shape, line by line: its first line, comments, the export,
 * and nothing but `<via name="VCM<n>" ... connectsTo="net.<one net>">` lines as
 * the tool writes them. One line more, or one changed, and it is someone's.
 */

import type { EsitoCucitura, Punto } from "./ground-stitching";
import { stratiDiRame } from "./via-layers";

type El = { type: string; [key: string]: unknown };

export const FILE_CUCITURA = "cucitura-massa.tsx";
export const COMPONENTE_CUCITURA = "CucituraMassa";
export const RIGA_IMPORT = `import { ${COMPONENTE_CUCITURA} } from "./cucitura-massa"`;
export const RIGA_USO = `<${COMPONENTE_CUCITURA} />`;
/** the names of the vias: VCM1, VCM2... ("via di cucitura della massa") */
const PREFISSO = "VCM";

/** a net a selector "net.X" can name */
const RETE_SCRIVIBILE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const n3 = (v: number): string => String(Math.round(v * 1000) / 1000);

/** the text of cucitura-massa.tsx for these vias, or why it cannot be written */
export function fileDellaCucitura(esito: EsitoCucitura): { contenuto: string } | { errore: string } {
  const rete = esito.rete.nome;
  if (!RETE_SCRIVIBILE.test(rete)) {
    return { errore: "il nome della rete non si puo' scrivere come net.<nome> in tscircuit (lettere, cifre e _)" };
  }
  const foro = n3(esito.via.foroMm);
  const corona = n3(esito.via.coronaMm);
  const righe = esito.vie.map(
    (v, i) =>
      `    <via name="${PREFISSO}${i + 1}" pcbX={${n3(v.x)}} pcbY={${n3(v.y)}} connectsTo="net.${rete}" fromLayer="top" toLayer="bottom" holeDiameter={${foro}} outerDiameter={${corona}} />`,
  );
  const griglia = `passo ${n3(esito.passoMm)} mm ${esito.sfalsata ? "sfalsato" : "regolare"}`;
  const bordo = esito.bordo.attiva ? `, fila sul bordo ogni ${n3(esito.bordo.passoMm)} mm` : "";
  const contenuto = [
    `// Cucitura della massa (rete ${rete}): ${esito.vie.length} vie passanti, foro ${foro} mm, corona ${corona} mm, ${griglia}${bordo}.`,
    `// ${esito.conteggio.isola} per le isole di massa, ${esito.conteggio.bordo} sul bordo, ${esito.conteggio.griglia} in griglia.`,
    "// Scritto dallo strumento stitch_ground di PCB Studio (\"Cuci la massa\"): rilanciato, riscrive questo file per intero.",
    `// Conta solo se main.tsx lo usa: ${RIGA_IMPORT} e ${RIGA_USO} dentro <board>.`,
    `export const ${COMPONENTE_CUCITURA} = () => (`,
    "  <>",
    ...righe,
    "  </>",
    ")",
    "",
  ].join("\n");
  return { contenuto };
}

/** how the tool's file begins: the first thing looked at before it is ever replaced */
const INTESTAZIONE = "// Cucitura della massa (rete ";
const RIGA_EXPORT = `export const ${COMPONENTE_CUCITURA} = () => (`;
/** a via line exactly as fileDellaCucitura writes it */
const RIGA_VIA = new RegExp(
  `^\\s*<via name="${PREFISSO}\\d+" pcbX=\\{(-?\\d+(?:\\.\\d+)?)\\} pcbY=\\{(-?\\d+(?:\\.\\d+)?)\\} connectsTo="net\\.([A-Za-z_][A-Za-z0-9_]*)" ` +
    `fromLayer="top" toLayer="bottom" holeDiameter=\\{\\d+(?:\\.\\d+)?\\} outerDiameter=\\{\\d+(?:\\.\\d+)?\\} />$`,
);

/** what a cucitura-massa.tsx of the project is */
export type FileCucitura =
  | { stato: "manca" }
  /** written by the tool: the net it stitches and where its vias are */
  | { stato: "dello_strumento"; rete: string | null; vie: Punto[] }
  /** anything else, with the first thing that is not the tool's */
  | { stato: "non_dello_strumento"; perche: string };

/**
 * A cucitura-massa.tsx read as the tool's own file, or told apart from one (see
 * the top of this file). `rete`: the one net its vias connect to, null when it
 * holds no via.
 */
export function leggiFileDellaCucitura(contenuto: string | undefined): FileCucitura {
  if (contenuto === undefined) return { stato: "manca" };
  if (!contenuto.startsWith(INTESTAZIONE)) return { stato: "non_dello_strumento", perche: "non comincia con l'intestazione che lo strumento scrive" };
  const righe = contenuto.split(/\r?\n/);
  while (righe.length > 0 && righe[righe.length - 1].trim() === "") righe.pop();
  let i = 0;
  while (i < righe.length && righe[i].startsWith("//")) i++;
  const diversa = (n: number, attesa: string): FileCucitura => ({ stato: "non_dello_strumento", perche: `alla riga ${n + 1} non c'e' ${attesa}` });
  if (righe[i] !== RIGA_EXPORT) return diversa(i, "la riga export dello strumento");
  if (righe[i + 1]?.trim() !== "<>") return diversa(i + 1, "l'apertura <> dello strumento");
  const vie: Punto[] = [];
  let rete: string | null = null;
  let k = i + 2;
  for (; k < righe.length; k++) {
    const m = RIGA_VIA.exec(righe[k]);
    if (!m) break;
    if (rete !== null && m[3] !== rete) return { stato: "non_dello_strumento", perche: `alla riga ${k + 1} c'e' una via di un'altra rete` };
    rete = m[3];
    vie.push({ x: Number(m[1]), y: Number(m[2]) });
  }
  if (righe[k]?.trim() !== "</>") return diversa(k, "una via di cucitura come lo strumento la scrive (VCM<n>, rete, foro e corona)");
  if (righe[k + 1] !== ")" || righe.length !== k + 2) return diversa(k + 1, "la chiusura dello strumento, e nient'altro dopo");
  return { stato: "dello_strumento", rete, vie };
}

/** the points of the vias a cucitura-massa.tsx of the tool holds; none for any other file */
export function vieDelFile(contenuto: string | undefined): Punto[] {
  const file = leggiFileDellaCucitura(contenuto);
  return file.stato === "dello_strumento" ? file.vie : [];
}

/** whether main.tsx imports the file and places its component */
export function mainLaUsa(main: string | undefined): boolean {
  if (!main) return false;
  const codice = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const importa = new RegExp(`import\\s*\\{[^}]*\\b${COMPONENTE_CUCITURA}\\b[^}]*\\}\\s*from\\s*["']\\./cucitura-massa(?:\\.tsx)?["']`).test(codice);
  return importa && new RegExp(`<${COMPONENTE_CUCITURA}\\s*/>`).test(codice);
}

/** another file of the project already names a via VCM<n>: two vias with one name */
export function nomiGiaUsati(files: Record<string, string>): string | null {
  for (const [path, testo] of Object.entries(files)) {
    if (path === FILE_CUCITURA || !path.endsWith(".tsx")) continue;
    if (new RegExp(`name=["']${PREFISSO}\\d+["']`).test(testo)) return path;
  }
  return null;
}

/**
 * The pcb_via elements the file makes once compiled, as tscircuit writes them
 * for `<via connectsTo="net.X" fromLayer="top" toLayer="bottom">`: on every
 * layer, with the net's connectivity key and the net's subcircuit (a `<via>`
 * of the project lives in the board's subcircuit; without it the pour solver
 * files it with the hand-drawn vias that carry none, and refuses the board
 * because one key maps to two nets). For checking a board with the vias in
 * memory, before anyone compiles it.
 */
export function vieComeElementi(esito: EsitoCucitura, circuitJson: unknown[]): El[] {
  const els = circuitJson as El[];
  const rete = els.find((el) => el.type === "source_net" && el.source_net_id === esito.rete.id);
  const chiave = String(rete?.subcircuit_connectivity_map_key ?? `net:${esito.rete.id}`);
  const sottocircuito = typeof rete?.subcircuit_id === "string" ? { subcircuit_id: rete.subcircuit_id } : {};
  const board = els.find((el) => el.type === "pcb_board");
  const layers = stratiDiRame(typeof board?.num_layers === "number" ? board.num_layers : 2);
  return esito.vie.map((v, i) => ({
    ...sottocircuito,
    type: "pcb_via",
    pcb_via_id: `pcb_via_cucitura_${i}`,
    x: v.x,
    y: v.y,
    hole_diameter: esito.via.foroMm,
    outer_diameter: esito.via.coronaMm,
    layers,
    from_layer: "top",
    to_layer: "bottom",
    pcb_trace_id: esito.rete.id,
    subcircuit_connectivity_map_key: chiave,
  }));
}
