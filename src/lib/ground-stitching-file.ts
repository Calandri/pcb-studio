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

/** the points of the vias a cucitura-massa.tsx holds */
export function vieDelFile(contenuto: string | undefined): Punto[] {
  if (!contenuto) return [];
  const out: Punto[] = [];
  for (const m of contenuto.matchAll(/<via\b[^>]*?\bpcbX=\{(-?\d+(?:\.\d+)?)\}[^>]*?\bpcbY=\{(-?\d+(?:\.\d+)?)\}/g)) {
    out.push({ x: Number(m[1]), y: Number(m[2]) });
  }
  return out;
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
