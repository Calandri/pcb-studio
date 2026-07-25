export type FsMap = Record<string, string>;

const DEMO_MAIN = `export default () => (
  <board width="34mm" height="24mm">
    <chip
      name="U1"
      footprint="soic8"
      pcbX={0}
      pcbY={0}
      pinLabels={{
        pin1: "GND",
        pin2: "TRIG",
        pin3: "OUT",
        pin4: "RESET",
        pin5: "CTRL",
        pin6: "THRES",
        pin7: "DISCH",
        pin8: "VCC",
      }}
    />
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={-10} pcbY={6} />
    <resistor name="R2" resistance="47k" footprint="0402" pcbX={-10} pcbY={0} />
    <resistor name="R3" resistance="220" footprint="0402" pcbX={10} pcbY={6} />
    <capacitor name="C1" capacitance="10uF" footprint="0603" pcbX={-10} pcbY={-6} />
    <led name="D1" footprint="0603" pcbX={10} pcbY={-6} />
    <net name="VCC" />
    <net name="GND" />

    <trace from=".U1 > .VCC" to="net.VCC" />
    <trace from=".U1 > .RESET" to="net.VCC" />
    <trace from=".U1 > .GND" to="net.GND" />
    <trace from=".R1 > .pin1" to="net.VCC" />
    <trace from=".R1 > .pin2" to=".U1 > .DISCH" />
    <trace from=".R2 > .pin1" to=".U1 > .DISCH" />
    <trace from=".R2 > .pin2" to=".U1 > .THRES" />
    <trace from=".U1 > .THRES" to=".U1 > .TRIG" />
    <trace from=".C1 > .pin1" to=".U1 > .TRIG" />
    <trace from=".C1 > .pin2" to="net.GND" />
    <trace from=".U1 > .OUT" to=".R3 > .pin1" />
    <trace from=".R3 > .pin2" to=".D1 > .anode" />
    <trace from=".D1 > .cathode" to="net.GND" />
  </board>
)
`;

// globalThis so the store survives Next dev HMR reloads. Persistence on Neon
// replaces this in the persistence phase of the masterplan.
const globalStore = globalThis as unknown as {
  __pcbStudioProjects?: Map<string, FsMap>;
};

function projects(): Map<string, FsMap> {
  if (!globalStore.__pcbStudioProjects) {
    globalStore.__pcbStudioProjects = new Map();
  }
  return globalStore.__pcbStudioProjects;
}

export function getProject(projectId: string): FsMap {
  const store = projects();
  if (!store.has(projectId)) {
    store.set(projectId, { "main.tsx": DEMO_MAIN });
  }
  return store.get(projectId)!;
}

export function writeProjectFile(
  projectId: string,
  path: string,
  content: string,
): void {
  getProject(projectId)[path] = content;
}
