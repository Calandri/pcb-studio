import { simulate } from "spicey";

const MAX_NETLIST_CHARS = 20_000;
const MAX_WAVEFORM_NODES = 4;
const WAVEFORM_POINTS = 50;
const MAX_STAT_NODES = 8;

export interface SimulateSummary {
  ok: boolean;
  error?: string;
  tran?: {
    durationS: number;
    points: number;
    nodes: Record<
      string,
      { min: number; max: number; final: number; estFreqHz: number | null }
    >;
    /** downsampled waveforms for the first few nodes (shape inspection) */
    waveforms: Record<string, { times: number[]; values: number[] }>;
  };
  ac?: {
    freqRangeHz: [number, number];
    points: number;
    nodes: Record<
      string,
      { magStart: number; magEnd: number; magMax: number; freqAtMaxHz: number }
    >;
  };
  message: string;
}

const round = (v: number): number =>
  Number.isFinite(v) ? Number(v.toPrecision(4)) : 0;

function downsample(series: number[], points: number): number[] {
  if (series.length <= points) return series.map(round);
  const out: number[] = [];
  const step = (series.length - 1) / (points - 1);
  for (let i = 0; i < points; i++) out.push(round(series[Math.round(i * step)]));
  return out;
}

/** rough oscillation frequency: mean-crossings in the steady second half */
function estimateFreqHz(times: number[], values: number[]): number | null {
  const n = values.length;
  if (n < 8) return null;
  const start = Math.floor(n / 2);
  const t = times.slice(start);
  const v = values.slice(start);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  let crossings = 0;
  for (let i = 1; i < v.length; i++) {
    if ((v[i - 1] - mean) * (v[i] - mean) < 0) crossings++;
  }
  const span = t[t.length - 1] - t[0];
  if (crossings < 2 || span <= 0) return null;
  // two crossings per period
  return round(crossings / 2 / span);
}

/**
 * Server-side SPICE simulation (spicey, pure JS). The netlist comes from the
 * LLM and is treated as data: spicey only parses and solves it numerically,
 * no code evaluation. Output is compacted so the model can read waveforms
 * without blowing up the context.
 */
export function runSimulation(netlist: string): SimulateSummary {
  if (!netlist.trim()) {
    return { ok: false, error: "netlist is required", message: "No netlist provided." };
  }
  if (netlist.length > MAX_NETLIST_CHARS) {
    return {
      ok: false,
      error: `netlist too large (${netlist.length} chars, max ${MAX_NETLIST_CHARS})`,
      message: "Netlist too large.",
    };
  }

  let result: ReturnType<typeof simulate>;
  try {
    result = simulate(netlist);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message.slice(0, 500),
      message: `Simulation failed: ${message.slice(0, 300)}`,
    };
  }

  const summary: SimulateSummary = { ok: true, message: "" };

  if (result.tran) {
    const { times, nodeVoltages } = result.tran;
    const nodeNames = Object.keys(nodeVoltages).filter((n) => n !== "0");
    const stats: NonNullable<SimulateSummary["tran"]>["nodes"] = {};
    for (const node of nodeNames.slice(0, MAX_STAT_NODES)) {
      const v = nodeVoltages[node];
      stats[node] = {
        min: round(Math.min(...v)),
        max: round(Math.max(...v)),
        final: round(v[v.length - 1]),
        estFreqHz: estimateFreqHz(times, v),
      };
    }
    const waveforms: NonNullable<SimulateSummary["tran"]>["waveforms"] = {};
    for (const node of nodeNames.slice(0, MAX_WAVEFORM_NODES)) {
      waveforms[node] = {
        times: downsample(times, WAVEFORM_POINTS),
        values: downsample(nodeVoltages[node], WAVEFORM_POINTS),
      };
    }
    summary.tran = {
      durationS: round(times[times.length - 1] ?? 0),
      points: times.length,
      nodes: stats,
      waveforms,
    };
  }

  if (result.ac) {
    const { freqs, nodeVoltages } = result.ac;
    const nodeNames = Object.keys(nodeVoltages).filter((n) => n !== "0");
    const nodes: NonNullable<SimulateSummary["ac"]>["nodes"] = {};
    for (const node of nodeNames.slice(0, MAX_STAT_NODES)) {
      const mags = nodeVoltages[node].map((c) => c.abs());
      const iMax = mags.indexOf(Math.max(...mags));
      nodes[node] = {
        magStart: round(mags[0]),
        magEnd: round(mags[mags.length - 1]),
        magMax: round(mags[iMax]),
        freqAtMaxHz: round(freqs[iMax]),
      };
    }
    summary.ac = {
      freqRangeHz: [round(freqs[0]), round(freqs[freqs.length - 1])],
      points: freqs.length,
      nodes,
    };
  }

  if (!summary.tran && !summary.ac) {
    return {
      ok: false,
      error: "no analysis ran: the netlist needs a .tran and/or .ac card",
      message: "No analysis ran (missing .tran/.ac card).",
    };
  }

  const parts: string[] = [];
  if (summary.tran) {
    parts.push(
      `TRAN ${summary.tran.durationS}s, ${Object.keys(summary.tran.nodes).length} nodes`,
    );
  }
  if (summary.ac) {
    parts.push(
      `AC ${summary.ac.freqRangeHz[0]}-${summary.ac.freqRangeHz[1]}Hz, ${Object.keys(summary.ac.nodes).length} nodes`,
    );
  }
  summary.message = `Simulation OK: ${parts.join(" + ")}.`;
  return summary;
}
