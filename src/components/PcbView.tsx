"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import { ViewControls } from "./ViewControls";
import { VIEW_PRESETS, type ViewFlags, type ViewPreset } from "./ViewPresets";

// Il viewer PCB usato direttamente (non via RunFrame): e' l'unico modo per
// controllare da fuori quali livelli sono accesi.
const PcbViewer = dynamic(
  () => import("@tscircuit/runframe/runner").then((m) => m.PcbViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-faint">
        <span className="dot dot-busy mr-2" /> Caricamento vista PCB...
      </div>
    ),
  },
);

/**
 * Vista PCB con i controlli dei livelli. Il viewer non espone metodi per
 * cambiare stato dopo il montaggio: si rimonta con una key derivata dai flag,
 * che e' istantaneo e mantiene il codice semplice.
 */
export function PcbView({ circuitJson }: { circuitJson: unknown[] }) {
  const [preset, setPreset] = useState<string>("overview");
  const [flags, setFlags] = useState<ViewFlags>(
    () => VIEW_PRESETS.find((p) => p.key === "overview")!.flags,
  );
  const [layer, setLayer] = useState("top");

  const applyPreset = useCallback((p: ViewPreset) => {
    setPreset(p.key);
    setFlags(p.flags);
  }, []);

  const setFlag = useCallback((key: keyof ViewFlags, value: boolean) => {
    setPreset("custom");
    setFlags((f) => ({ ...f, [key]: value }));
  }, []);

  const viewerKey = useMemo(
    () => `${layer}-${Object.values(flags).map((v) => (v ? 1 : 0)).join("")}`,
    [layer, flags],
  );

  return (
    <div className="relative h-full">
      <div className="absolute bottom-3 left-3 z-10 flex gap-2">
        <ViewControls
          preset={preset}
          flags={flags}
          layer={layer}
          onPreset={applyPreset}
          onFlag={setFlag}
          onLayer={setLayer}
        />
      </div>
      <PcbViewer
        key={viewerKey}
        circuitJson={circuitJson as never}
        initialState={{ ...flags, selected_layer: layer } as never}
        clickToInteractEnabled={false}
      />
    </div>
  );
}
