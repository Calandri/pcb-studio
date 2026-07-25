"use client";

import dynamic from "next/dynamic";

const RunFrame = dynamic(
  () => import("@tscircuit/runframe/runner").then((m) => m.RunFrame),
  { ssr: false, loading: () => <FullscreenMessage text="Caricamento runtime tscircuit..." /> },
);

function FullscreenMessage({ text }: { text: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-neutral-400">
      {text}
    </div>
  );
}

const DEMO_FS_MAP: Record<string, string> = {
  "main.tsx": `export default () => (
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
`,
};

export function StudioDemo() {
  return (
    <div className="h-dvh w-full bg-neutral-950">
      <RunFrame
        fsMap={DEMO_FS_MAP}
        mainComponentPath="main.tsx"
        defaultToFullScreen
        showRunButton={false}
        availableTabs={["schematic", "pcb", "cad", "bom"]}
        defaultActiveTab="schematic"
      />
    </div>
  );
}
