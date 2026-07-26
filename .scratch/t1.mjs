import { runTscircuitCode } from "@tscircuit/eval";

const base = (extra) => `export default () => (
  <board width="34mm" height="24mm" ${extra}>
    <schematicsection name="a" displayName="Sezione A" />
    <schematicsection name="b" displayName="Sezione B" />
    <resistor name="R1" resistance="10k" footprint="0402" schSectionName="a" pcbX={-6} pcbY={0} />
    <resistor name="R2" resistance="47k" footprint="0402" schSectionName="a" pcbX={0} pcbY={0} />
    <capacitor name="C1" capacitance="10uF" footprint="0603" schSectionName="b" pcbX={6} pcbY={0} />
    <net name="GND" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    <trace from=".R2 > .pin2" to=".C1 > .pin1" />
    <trace from=".C1 > .pin2" to="net.GND" />
  </board>
)`;

const centers = (cj) => Object.fromEntries(cj.filter(e => e.type === "schematic_component").map(e => {
  const sc = cj.find(s => s.type === "source_component" && s.source_component_id === e.source_component_id);
  return [sc?.name ?? e.schematic_component_id, [Math.round(e.center.x*100)/100, Math.round(e.center.y*100)/100]];
}));
const pcbCenters = (cj) => Object.fromEntries(cj.filter(e => e.type === "pcb_component").map(e => {
  const sc = cj.find(s => s.type === "source_component" && s.source_component_id === e.source_component_id);
  return [sc?.name ?? "?", [Math.round(e.center.x*100)/100, Math.round(e.center.y*100)/100]];
}));

const run = async (label, extra) => {
  const cj = await runTscircuitCode({ "main.tsx": base(extra) }, { mainComponentPath: "main.tsx" });
  console.log(label, "SCH", JSON.stringify(centers(cj)), "PCB", JSON.stringify(pcbCenters(cj)));
  const warn = cj.filter(e => String(e.type).includes("warning")).map(e => e.message);
  if (warn.length) console.log("   warn:", warn.slice(0,3));
};

const me = { schematic_placements: [{ selector: "C1", center: { x: 8, y: 4 }, relative_to: "group_center" }],
             pcb_placements: [{ selector: "C1", center: { x: 2, y: 8 }, relative_to: "group_center" }] };

await run("BASE     ", "");
await run("MANUAL   ", `manualEdits={${JSON.stringify(me)}}`);
