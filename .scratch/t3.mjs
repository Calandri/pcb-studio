import { runTscircuitCode } from "@tscircuit/eval";
const mk = (comps, extra="") => `export default () => (
  <board width="34mm" height="24mm" ${extra}>
    ${comps}
    <net name="GND" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    <trace from=".R2 > .pin2" to=".C1 > .pin1" />
    <trace from=".C1 > .pin2" to="net.GND" />
  </board>
)`;
const centers = (cj, t) => Object.fromEntries(cj.filter(e => e.type === t).map(e => {
  const sc = cj.find(s => s.type === "source_component" && s.source_component_id === e.source_component_id);
  return [sc?.name ?? "?", [Math.round(e.center.x*100)/100, Math.round(e.center.y*100)/100]];
}));
const run = async (label, comps, extra) => {
  try {
    const cj = await runTscircuitCode({ "main.tsx": mk(comps, extra) }, { mainComponentPath: "main.tsx" });
    const lines = cj.filter(e=>e.type==="schematic_line").length, txt = cj.filter(e=>e.type==="schematic_text").length;
    console.log(label, JSON.stringify(centers(cj,"schematic_component")), "lines",lines,"texts",txt);
  } catch(e){ console.log(label, "ERR", e.message); }
};
// A: sezioni + schX/schY su tutti
await run("sect+schXY ", `<schematicsection name="a" displayName="A" /><schematicsection name="b" displayName="B" />
    <resistor name="R1" resistance="10k" footprint="0402" schSectionName="a" schX={-4} schY={2} />
    <resistor name="R2" resistance="47k" footprint="0402" schSectionName="a" schX={0} schY={2} />
    <capacitor name="C1" capacitance="10uF" footprint="0603" schSectionName="b" schX={4} schY={-2} />`);
// B: nessuna sezione + schX/schY su tutti
await run("schXY only ", `<resistor name="R1" resistance="10k" footprint="0402" schX={-4} schY={2} />
    <resistor name="R2" resistance="47k" footprint="0402" schX={0} schY={2} />
    <capacitor name="C1" capacitance="10uF" footprint="0603" schX={4} schY={-2} />`);
// C: nessuna sezione, manualEdits su tutti
const me = { schematic_placements: [
  {selector:"R1",center:{x:-4,y:2},relative_to:"group_center"},
  {selector:"R2",center:{x:0,y:2},relative_to:"group_center"},
  {selector:"C1",center:{x:4,y:-2},relative_to:"group_center"}]};
await run("manualEdits", `<resistor name="R1" resistance="10k" footprint="0402" />
    <resistor name="R2" resistance="47k" footprint="0402" />
    <capacitor name="C1" capacitance="10uF" footprint="0603" />`, `manualEdits={${JSON.stringify(me)}}`);
