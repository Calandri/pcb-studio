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
    console.log(label, "SCH", JSON.stringify(centers(cj,"schematic_component")), "PCB", JSON.stringify(centers(cj,"pcb_component")),
      "hints", cj.filter(e=>e.type==="pcb_trace_hint").length, "traces", cj.filter(e=>e.type==="pcb_trace").length);
  } catch(e){ console.log(label, "ERR", e.message); }
};
const S = (x) => `<schematicsection name="a" displayName="A" /><schematicsection name="b" displayName="B" />
    <resistor name="R1" resistance="10k" footprint="0402" schSectionName="a" pcbX={-6} pcbY={0} ${x.R1??""} />
    <resistor name="R2" resistance="47k" footprint="0402" schSectionName="a" pcbX={0} pcbY={0} ${x.R2??""} />
    <capacitor name="C1" capacitance="10uF" footprint="0603" schSectionName="b" pcbX={6} pcbY={0} ${x.C1??""} />`;
await run("sect none    ", S({}));
await run("sect C1 only ", S({C1:"schX={5} schY={3}"}));
await run("sect all     ", S({R1:"schX={-4} schY={2}",R2:"schX={0} schY={2}",C1:"schX={5} schY={3}"}));
// trace hints
const hints = { manual_trace_hints: [{ pcb_port_selector: ".R2 > .pin2", offsets: [{x:3,y:5},{x:6,y:5}] }] };
await run("hints        ", S({}), `manualEdits={${JSON.stringify(hints)}}`);
