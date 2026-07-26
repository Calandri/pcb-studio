import { runTscircuitCode } from "@tscircuit/eval";
import { injectManualEdits, parseManualEdits, applyEditEvents, serializeManualEdits } from "./lib/manual-edits.ts";

const main = `export default () => (
  <board width="34mm" height="24mm" schTraceAutoLabelEnabled>
    <schematicsection name="a" displayName="A" />
    <schematicsection name="b" displayName="B" />
    <resistor name="R1" resistance="10k" footprint="0402" schSectionName="a" pcbX={-6} pcbY={0} />
    <resistor name="R2" resistance="47k" footprint="0402" schSectionName="a" pcbX={0} pcbY={0} />
    <capacitor name="C1" capacitance="10uF" footprint="0603" schSectionName="b" pcbX={6} pcbY={0} />
    <net name="GND" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    <trace from=".R2 > .pin2" to=".C1 > .pin1" />
    <trace from=".C1 > .pin2" to="net.GND" />
  </board>
)`;
const centers = (cj: any[], t: string) => Object.fromEntries(cj.filter(e => e.type === t).map(e => {
  const sc = cj.find(s => s.type === "source_component" && s.source_component_id === e.source_component_id);
  return [sc?.name ?? "?", [Math.round(e.center.x*100)/100, Math.round(e.center.y*100)/100]];
}));

const before = await runTscircuitCode({ "main.tsx": main }, { mainComponentPath: "main.tsx" }) as any[];
console.log("PRIMA   SCH", JSON.stringify(centers(before,"schematic_component")), "PCB", JSON.stringify(centers(before,"pcb_component")));

// l'utente trascina C1 nello schematico e R1 sul rame, e disegna una pista
const schC1 = before.find(e => e.type==="schematic_component" && before.find(s=>s.type==="source_component"&&s.source_component_id===e.source_component_id)?.name==="C1");
const pcbR1 = before.find(e => e.type==="pcb_component" && before.find(s=>s.type==="source_component"&&s.source_component_id===e.source_component_id)?.name==="R1");
const port = before.find(e => e.type==="pcb_port");
const events = [
  { edit_event_type: "edit_schematic_component_location", schematic_component_id: schC1.schematic_component_id,
    original_center: schC1.center, new_center: { x: schC1.center.x + 2, y: schC1.center.y + 3 } },
  { edit_event_type: "edit_pcb_component_location", pcb_component_id: pcbR1.pcb_component_id,
    original_center: pcbR1.center, new_center: { x: -4, y: 5 } },
  { pcb_edit_event_type: "edit_trace_hint", pcb_port_id: port.pcb_port_id, route: [{ x: -3, y: 8 }, { x: 2, y: 8 }] },
];
const edits = applyEditEvents({ circuitJson: before, main, edits: parseManualEdits(null), events });
console.log("EDITS", serializeManualEdits(edits).trim());

const after = await runTscircuitCode({ "main.tsx": injectManualEdits(main, edits) }, { mainComponentPath: "main.tsx" }) as any[];
console.log("DOPO    SCH", JSON.stringify(centers(after,"schematic_component")), "PCB", JSON.stringify(centers(after,"pcb_component")));
console.log("hints", after.filter(e=>e.type==="pcb_trace_hint").length, "errori", after.filter(e=>String(e.type).endsWith("_error")).length);
