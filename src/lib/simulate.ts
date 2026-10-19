import { parseNetlist, simulateAC, simulateTRAN } from "spicey";

const MAX_NETLIST_CHARS = 20_000;
/*
 * How many points an analysis may ask for. The netlist comes from the model:
 * a `.tran 1p 1` is a trillion steps, and spicey would try them all inside the
 * request. Twenty thousand characters of netlist cannot need more than this.
 */
const MAX_TRAN_STEPS = 200_000;
const MAX_AC_POINTS = 20_000;
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

/*
 * Minimum and maximum by walking the array. `Math.min(...v)` passes every
 * sample as an argument, and a long transient has more samples than the stack
 * has room for: the simulation succeeded and the summary blew up with a
 * RangeError, outside any try.
 */
function minMax(series: number[]): { min: number; max: number; iMax: number } {
  let min = Infinity;
  let max = -Infinity;
  let iMax = 0;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v < min) min = v;
    if (v > max) {
      max = v;
      iMax = i;
    }
  }
  return { min, max, iMax };
}

/** points an analysis will compute, from the cards already parsed */
function puntiRichiesti(ckt: ReturnType<typeof parseNetlist>): { tran: number; ac: number } {
  const tran = ckt.analyses.tran;
  const ac = ckt.analyses.ac;
  let tranSteps = 0;
  if (tran) {
    const tstop = Number(tran.tstop);
    const dt = Number(tran.dt);
    // the same rule spicey uses when the step is missing: a thousandth of the run
    const passo = dt > 0 ? dt : tstop / 1e3;
    tranSteps = tstop > 0 && passo > 0 ? Math.ceil(tstop / passo) : 0;
  }
  let acPoints = 0;
  if (ac) {
    const n = Number(ac.N);
    const f1 = Number(ac.f1);
    const f2 = Number(ac.f2);
    acPoints =
      ac.mode === "dec" && f1 > 0 && f2 > f1 ? Math.ceil(n * Math.log10(f2 / f1)) + 1 : n;
  }
  return {
    tran: Number.isFinite(tranSteps) ? tranSteps : Infinity,
    ac: Number.isFinite(acPoints) ? acPoints : Infinity,
  };
}

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

  let result: { ac: ReturnType<typeof simulateAC>; tran: ReturnType<typeof simulateTRAN> };
  try {
    const circuit = parseNetlist(netlist);
    const punti = puntiRichiesti(circuit);
    if (punti.tran > MAX_TRAN_STEPS || punti.ac > MAX_AC_POINTS) {
      const error =
        punti.tran > MAX_TRAN_STEPS
          ? `.tran asks for ${punti.tran} steps (max ${MAX_TRAN_STEPS}): use a larger timestep or a shorter stop time`
          : `.ac asks for ${punti.ac} points (max ${MAX_AC_POINTS}): use fewer points per decade`;
      return { ok: false, error, message: `Simulation refused: ${error}` };
    }
    result = { ac: simulateAC(circuit), tran: simulateTRAN(circuit) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message.slice(0, 500),
      message: `Simulation failed: ${message.slice(0, 300)}`,
    };
  }

  try {
    return summarizeResult(result);
  } catch (err) {
    // whatever the solver handed back, the tool answers instead of throwing
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message.slice(0, 500),
      message: `Simulation summary failed: ${message.slice(0, 300)}`,
    };
  }
}

function summarizeResult(result: {
  ac: ReturnType<typeof simulateAC>;
  tran: ReturnType<typeof simulateTRAN>;
}): SimulateSummary {
  const summary: SimulateSummary = { ok: true, message: "" };

  if (result.tran) {
    const { times, nodeVoltages } = result.tran;
    const nodeNames = Object.keys(nodeVoltages).filter((n) => n !== "0");
    const stats: NonNullable<SimulateSummary["tran"]>["nodes"] = {};
    for (const node of nodeNames.slice(0, MAX_STAT_NODES)) {
      const v = nodeVoltages[node];
      const { min, max } = minMax(v);
      stats[node] = {
        min: round(min),
        max: round(max),
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
      const { iMax } = minMax(mags);
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
