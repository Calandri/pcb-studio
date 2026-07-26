import { runTscircuitCode } from "@tscircuit/eval";
const mk = (extra, comps) => `export default () => (
  <board width="34mm" height="24mm" ${extra}>
    ${comps}
    <net name="GND" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    <trace from=".R2 > .pin2" to=".C1 > .pin1" />
    <trace from=".C1 > .pin2" to="net.GND" />
  </board>
)`;
const NOCOORD = `<resistor name="R1" resistance="10k" footprint="0402" />
    <resistor name="R2" resistance="47k" footprint="0402" />
    <capacitor name="C1" capacitance="10uF" footprint="0603" />`;
const SECT = `<schematicsection name="a" displayName="A" /><schematicsection name="b" displayName="B" />
    <resistor name="R1" resistance="10k" footprint="0402" schSectionName="a" />
    <resistor name="R2" resistance="47k" footprint="0402" schSectionName="a" />
    <capacitor name="C1" capacitance="10uF" footprint="0603" schSectionName="b" />`;
const centers = (cj, t) => Object.fromEntries(cj.filter(e => e.type === t).map(e => {
  const sc = cj.find(s => s.type === "source_component" && s.source_component_id === e.source_component_id);
  return [sc?.name ?? "?", [Math.round(e.center.x*100)/100, Math.round(e.center.y*100)/100]];
}));
const run = async (label, extra, comps) => {
  const cj = await runTscircuitCode({ "main.tsx": mk(extra, comps) }, { mainComponentPath: "main.tsx" });
  console.log(label, "SCH", JSON.stringify(centers(cj,"schematic_component")), "PCB", JSON.stringify(centers(cj,"pcb_component")));
};
const me = { schematic_placements: [{ selector: "C1", center: { x: 8, y: 4 }, relative_to: "group_center" }],
             pcb_placements: [{ selector: "C1", center: { x: 2, y: 8 }, relative_to: "group_center" }] };
const meProp = `manualEdits={${JSON.stringify(me)}}`;
await run("nocoord base  ", "", NOCOORD);
await run("nocoord manual", meProp, NOCOORD);
await run("sect    base  ", "", SECT);
await run("sect    manual", meProp, SECT);
