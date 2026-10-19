import { KicadToCircuitJsonConverter } from "kicad-to-circuit-json";
import { parseKicadModToCircuitJson } from "kicad-component-converter";
import {
  circuitJsonToProjectFiles,
  commentSafe,
  etichetteDeiPin,
  footprintJsx,
  toPascalCase,
  type El,
} from "./circuit-json-to-project";

/**
 * KiCad import (Fase 3.g): .kicad_mod footprint -> library component TSX,
 * .kicad_pcb (+ optional .kicad_sch) -> tscircuit project files.
 *
 * The converters emit Circuit JSON; we serialize it back to tscircuit code
 * because the project document IS code (the agent edits it with write_file).
 * Footprints are rebuilt inline from the pcb elements (the converter expands
 * them), so imported designs keep their REAL pad geometry — no guessing.
 *
 * Altium has its own importer now (altium-import.ts).
 */

// ---------------------------------------------------------------------------
// component import: .kicad_mod -> library component TSX
// ---------------------------------------------------------------------------

export interface ImportedKicadComponent {
  name: string;
  code: string;
}

export async function importKicadFootprint(
  filename: string,
  content: string,
): Promise<ImportedKicadComponent> {
  const soup = (await parseKicadModToCircuitJson(content)) as El[];
  const base = filename.replace(/\.kicad_mod$/i, "");
  const name = toPascalCase(base);

  /*
   * `pin<n>` for the pad NUMBERED n: numbering the sorted pads from one put
   * every label after a gap (pads 1, 2, 4, 5) on the wrong pad.
   */
  const pinLabels = etichetteDeiPin(soup);

  const body = footprintJsx(soup, {}, "      ");
  const code = `// Importato da KiCad footprint: ${commentSafe(`${base}.kicad_mod`, 120)}
export const ${name} = (props: any) => (
  <chip
    {...props}
    footprint={
      <footprint>
${body}
      </footprint>
    }${pinLabels ? `\n    pinLabels={${pinLabels}}` : ""}
  />
)
`;
  return { name, code };
}

// ---------------------------------------------------------------------------
// project import: .kicad_pcb (+ .kicad_sch) -> main.tsx
// ---------------------------------------------------------------------------

export interface ImportedKicadProject {
  fsMap: Record<string, string>;
  stats: Record<string, number | undefined>;
  warnings: string[];
  components: number;
  traces: number;
}


export function importKicadProject(
  files: Array<{ path: string; content: string }>,
): ImportedKicadProject {
  const converter = new KicadToCircuitJsonConverter();
  for (const f of files) converter.addFile(f.path, f.content);
  converter.runUntilFinished();
  const cj = converter.getOutput() as El[];
  const stats = converter.getStats();
  const warnings = converter.getWarnings();

  const progetto = circuitJsonToProjectFiles(cj, {
    origine: `Importato da KiCad (${files.map((f) => f.path).join(", ")})`,
  });
  return {
    fsMap: progetto.fsMap,
    stats,
    warnings: [...warnings, ...progetto.warnings],
    components: progetto.components,
    traces: progetto.traces,
  };
}
