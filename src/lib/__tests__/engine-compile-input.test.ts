import { describe, expect, it } from "vitest";
import { compileProject } from "@/lib/compile";
import { applyManualEditsToFsMap } from "@/lib/manual-edits";
import { filesHash } from "@/lib/project-store";

const MAIN = `export default () => (
  <board width="10mm" height="10mm">
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={0} pcbY={0} />
  </board>
)
`;

describe("compile leaves the project files alone", () => {
  it("applyManualEditsToFsMap returns a copy even without manual edits", () => {
    const files = { "main.tsx": MAIN };
    expect(applyManualEditsToFsMap(files)).not.toBe(files);
  });

  it("the hash of the files is the same before and after compileProject", async () => {
    const files = { "main.tsx": MAIN };
    const before = filesHash(files);
    await compileProject(files, { route: false });
    expect(Object.keys(files)).toEqual(["main.tsx"]);
    expect(filesHash(files)).toBe(before);
  }, 120_000);
});

/*
 * sbb-dl-retro tiene i pezzi in parti_1.tsx: le posizioni spostate a mano
 * entravano solo in main.tsx, e dopo "Aggiorna" i pezzi tornavano dov'erano
 * nel file (2026-11-09).
 */
describe("le modifiche a mano valgono per i pezzi in ogni file del progetto", () => {
  const files = {
    "main.tsx": `import { Parti } from "./parti_1"
export default () => (
  <board width="20mm" height="10mm">
    <Parti />
  </board>
)
`,
    "parti_1.tsx": `export const Parti = () => (
  <>
    <resistor name="R6" resistance="10k" footprint="0402" pcbX={0} pcbY={0} />
  </>
)
`,
    "manual-edits.json": JSON.stringify({ pcb_placements: [{ selector: "R6", center: { x: 5, y: -2 }, rotation: 90 }] }),
  };

  it("il file con il pezzo riceve la posizione, main.tsx resta com'e'", () => {
    const out = applyManualEditsToFsMap(files);
    expect(out["parti_1.tsx"]).toContain("pcbX={5}");
    expect(out["parti_1.tsx"]).toContain("pcbRotation={90}");
    expect(out["main.tsx"]).toBe(files["main.tsx"]);
    expect(out["manual-edits.json"]).toBeUndefined();
  });

  it("e la scheda compilata ha il pezzo dove l'ha messo la persona", async () => {
    const { circuitJson } = await compileProject(files);
    const r6 = (circuitJson as Array<Record<string, unknown>>).find((e) => e.type === "pcb_component")!;
    expect(r6.display_offset_x).toBe(5);
    expect(r6.display_offset_y).toBe(-2);
    expect(r6.rotation).toBe(90);
  }, 120_000);
});
