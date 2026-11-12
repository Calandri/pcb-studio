import { describe, expect, it } from "vitest";
import { schematicKeyOf, soloCioCheLeggeLoSchematico } from "@/lib/compile";
import { injectManualEdits, parseJsxAttrs, scanJsxTags, scanJsxTagsOrNull } from "@/lib/manual-edits";

/*
 * Review of 11/11/2026: N lines `xN = (<a {` made the JSX scanner try every
 * `<` again inside every attempt around it, 2^N attempts: 334 ms with 20
 * lines, 16.5 s with 25, minutes with 30. The scanner runs on every code file
 * at every compile (the key of the schematic, the footprints) and on save, so
 * anyone who can edit a project could hold a compile for good.
 */
const righe = (n: number) => Array.from({ length: n }, (_, i) => `x${i} = (<a {`).join("\n");
const ms = (f: () => unknown) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};

describe("lo scanner JSX resta lineare su un file costruito apposta", () => {
  it("40 righe `xN = (<a {` si leggono in millisecondi, e un tag valido dopo si trova come prima", () => {
    expect(ms(() => scanJsxTags(righe(40)))).toBeLessThan(200);
    expect(scanJsxTags(righe(40))).toEqual([]);
    const dopo = `${righe(40)}\nconst y = <b c={1} />`;
    expect(scanJsxTags(dopo).map((t) => t.name)).toEqual(["b"]);
  });

  it("oltre i suoi limiti il file non e' leggibile: null a chi decide, nessun tag a chi cerca", () => {
    for (const src of ["<a>".repeat(300) + "</a>".repeat(300), "`${".repeat(2000) + "}`".repeat(2000), righe(5000)]) {
      expect(ms(() => expect(scanJsxTagsOrNull(src)).toBeNull())).toBeLessThan(500);
      expect(scanJsxTags(src)).toEqual([]);
    }
  });

  it("un file non leggibile entra nella chiave dello schematico cosi' com'e', e chi inietta le posizioni non si ferma", () => {
    const strano = `${"<a>".repeat(300)}<via pcbX={1} />${"</a>".repeat(300)}`;
    expect(soloCioCheLeggeLoSchematico(strano)).toBe(strano);
    expect(schematicKeyOf({ "main.tsx": strano })).not.toBe(schematicKeyOf({ "main.tsx": strano.replace("pcbX={1}", "pcbX={2}") }));
    const edits = { schematic_placements: [], pcb_placements: [{ selector: "R1", center: { x: 1, y: 2 } }], manual_trace_hints: [], pcb_routes: [], pcb_vias: [] };
    expect(injectManualEdits(strano, edits)).toBe(strano);
  });

  it("i tag e gli attributi di un file normale sono quelli di sempre", () => {
    const src = `// it's a comment with a <resistor> in it
const s = "<chip name='X' />"
const f = <T,>(x: T) => x
export default () => (
  <board width="10mm" height="10mm">
    {[1, 2].map((i) => <resistor name={\`R\${i}\`} resistance="1k" footprint="0402" pcbX={i < 2 ? -2 : 2} />)}
    <chip name="U1" footprint={<footprint><smtpad portHints={["1"]} pcbX={-1} pcbY={0} shape="rect" width={1} height={1} /></footprint>} />
    <trace from=".R1 > .pin1" to=".U1 > .pin1" />
  </board>
)`;
    const tags = scanJsxTagsOrNull(src, { includeNested: true });
    expect(tags?.map((t) => `${t.name}${t.inAttribute ? "*" : ""}`)).toEqual(["board", "resistor", "chip", "footprint*", "smtpad*", "trace"]);
    const chip = tags!.find((t) => t.name === "chip")!;
    expect(parseJsxAttrs(src.slice(chip.attrsStart, chip.attrsEnd)).map((a) => `${a.name}:${a.kind}`)).toEqual(["name:string", "footprint:expr"]);
  });
});
