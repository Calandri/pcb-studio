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

interface Controlled {
  preset: string;
  flags: ViewFlags;
  layer: string;
  onPreset: (p: ViewPreset) => void;
  onFlag: (key: keyof ViewFlags, value: boolean) => void;
  onLayer: (layer: string) => void;
}

/**
 * Vista PCB con i controlli dei livelli. Il viewer non espone metodi per
 * cambiare stato dopo il montaggio: si rimonta con una key derivata dai flag,
 * che e' istantaneo e mantiene il codice semplice.
 *
 * Puo' governarsi da sola oppure ricevere lo stato dall'esterno (workspace),
 * dove livelli e viste si scelgono dalla colonna di sinistra.
 */
export function PcbView({
  circuitJson,
  control,
  xray = 0,
  hideControls = false,
}: {
  circuitJson: unknown[];
  control?: Controlled;
  /** 0-100: schiarisce la vista per far emergere il rame degli strati sotto */
  xray?: number;
  hideControls?: boolean;
}) {
  const [ownPreset, setOwnPreset] = useState<string>("overview");
  const [ownFlags, setOwnFlags] = useState<ViewFlags>(
    () => VIEW_PRESETS.find((p) => p.key === "overview")!.flags,
  );
  const [ownLayer, setOwnLayer] = useState("top");

  const applyOwnPreset = useCallback((p: ViewPreset) => {
    setOwnPreset(p.key);
    setOwnFlags(p.flags);
  }, []);

  const setOwnFlag = useCallback((key: keyof ViewFlags, value: boolean) => {
    setOwnPreset("custom");
    setOwnFlags((f) => ({ ...f, [key]: value }));
  }, []);

  const preset = control?.preset ?? ownPreset;
  const flags = control?.flags ?? ownFlags;
  const layer = control?.layer ?? ownLayer;
  const onPreset = control?.onPreset ?? applyOwnPreset;
  const onFlag = control?.onFlag ?? setOwnFlag;
  const onLayer = control?.onLayer ?? setOwnLayer;

  const viewerKey = useMemo(
    () => `${layer}-${Object.values(flags).map((v) => (v ? 1 : 0)).join("")}`,
    [layer, flags],
  );

  return (
    <div className="relative h-full">
      {!hideControls && (
        <div className="absolute bottom-3 left-3 z-10 flex gap-2">
          <ViewControls
            preset={preset}
            flags={flags}
            layer={layer}
            onPreset={onPreset}
            onFlag={onFlag}
            onLayer={onLayer}
          />
        </div>
      )}
      <div
        className="h-full"
        style={
          xray > 0
            ? { filter: `brightness(${1 + xray / 90}) contrast(${1 + xray / 400})` }
            : undefined
        }
      >
        <PcbViewer
          key={viewerKey}
          circuitJson={circuitJson as never}
          initialState={{ ...flags, selected_layer: layer } as never}
          clickToInteractEnabled={false}
        />
      </div>
    </div>
  );
}
