import { injectManualEdits, scanJsxTags, readAttr, parseManualEdits, applyEditEvents } from "./lib/manual-edits.ts";

const main = `export default () => (
  <board width="34mm" height="24mm" autorouter="auto_cloud" schTraceAutoLabelEnabled>
    <schematicsection name="a" displayName="A" />
    <chip name="U1" footprint="soic8" schSectionName="a" pcbX={0} pcbY={0}
      pinLabels={{ pin1: "GND", pin2: "TRIG" }} />
    <resistor name="R1" resistance="10k" footprint="0402" schSectionName="a" pcbX={-10} pcbY={6} />
    <net name="GND" />
    <trace from=".U1 > .GND" to="net.GND" />
    <trace from=".R1 > .pin1" to=".U1 > .TRIG" />
  </board>
)`;

console.log("--- tags ---");
for (const t of scanJsxTags(main)) console.log(t.name, JSON.stringify(readAttr(main.slice(t.attrsStart,t.attrsEnd), "name")));

const edits = parseManualEdits(JSON.stringify({
  schematic_placements: [{ selector: "R1", center: { x: 3, y: -2 } }],
  pcb_placements: [{ selector: "U1", center: { x: 1.5, y: 2 } }],
  manual_trace_hints: [{ pcb_port_selector: ".R1 > .pin1", offsets: [{ x: -4, y: 6 }, { x: -4, y: 0, via: true }] }],
}));
console.log("--- injected ---");
console.log(injectManualEdits(main, edits));
