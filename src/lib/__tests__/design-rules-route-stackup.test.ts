import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The panel of the rules saves a preset and its rules through this route, and
 * the route builds design-rules.json anew: the stackup the project declares
 * (written by write_file, see stackup.test.ts) must still be in the file
 * afterwards, as it was. The real route and the real project store run here,
 * the store in memory; only who may write is a stand-in.
 */
vi.mock("@/lib/acl", () => ({ accessoDaRichiesta: vi.fn(async () => true) }));

import { GET, POST } from "@/app/api/design-rules/route";
import { DESIGN_RULES_PATH, resolveDesignRules, resolveStackup, type DesignRules } from "@/lib/design-rules";
import { getProject, writeProjectFile } from "@/lib/project-store";

/** st-camera: JLCPCB JLC06161H-3313, as jlcpcb.com/impedance gives it */
const ST_CAMERA = {
  copperMm: [0.035, 0.0152, 0.0152, 0.0152, 0.0152, 0.035],
  dielectrics: [
    { mm: 0.0994, er: 4.1, kind: "prepreg", name: "3313" },
    { mm: 0.55, er: 4.6, kind: "core" },
    { mm: 0.1164, er: 4.16, kind: "prepreg", name: "2116" },
    { mm: 0.55, er: 4.6, kind: "core" },
    { mm: 0.0994, er: 4.1, kind: "prepreg", name: "3313" },
  ],
};

const BASE = "https://pcb.example.com/api/design-rules";
let progetto = "";
let n = 0;

const salva = (corpo: Record<string, unknown>) =>
  POST(new Request(BASE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: progetto, ...corpo }) }));
const file = async () => (await getProject(progetto))[DESIGN_RULES_PATH];
const scritto = async () => JSON.parse(await file()) as { preset: string; rules?: Partial<DesignRules>; stackup?: unknown };

beforeEach(() => {
  // no database: the store keeps the projects in memory, one new project per test
  vi.stubEnv("DATABASE_URL", "");
  progetto = `pila-${++n}`;
});

describe("il pannello delle regole salva e la pila resta", () => {
  it("da regole a mano ad altre regole a mano: le regole cambiano, la pila e' quella di prima", async () => {
    await writeProjectFile(progetto, DESIGN_RULES_PATH, JSON.stringify({ preset: "custom", rules: { minTraceWidthMm: 0.15 }, stackup: ST_CAMERA }));
    const res = await salva({ preset: "custom", rules: { minTraceWidthMm: 0.2, minClearanceMm: 0.2 } });
    expect(res.status).toBe(200);
    const dopo = await scritto();
    expect(Object.keys(dopo)).toEqual(["preset", "rules", "stackup"]);
    expect(dopo.stackup).toEqual(ST_CAMERA);
    expect(dopo.rules).toMatchObject({ minTraceWidthMm: 0.2, minClearanceMm: 0.2 });
    expect(resolveStackup(await getProject(progetto))).toEqual({ stackup: ST_CAMERA });
    expect(resolveDesignRules(await getProject(progetto)).rules.minTraceWidthMm).toBe(0.2);
  });

  it("da regole a mano a un preset di fabbrica, e ritorno: resta in tutti e due i versi", async () => {
    await writeProjectFile(progetto, DESIGN_RULES_PATH, JSON.stringify({ preset: "custom", rules: { minTraceWidthMm: 0.15 }, stackup: ST_CAMERA }));
    expect((await salva({ preset: "oshpark" })).status).toBe(200);
    expect(await scritto()).toEqual({ preset: "oshpark", stackup: ST_CAMERA });
    expect((await salva({ preset: "custom", rules: { minViaHoleMm: 0.2, minViaDiameterMm: 0.45 } })).status).toBe(200);
    const dopo = await scritto();
    expect(dopo.preset).toBe("custom");
    expect(dopo.stackup).toEqual(ST_CAMERA);
  });

  it("come fa il pannello: legge le regole, le rimanda cambiate, e la pila non passa dal pannello", async () => {
    await writeProjectFile(progetto, DESIGN_RULES_PATH, JSON.stringify({ preset: "custom", rules: { minTraceWidthMm: 0.15 }, stackup: ST_CAMERA }));
    const letto = (await (await GET(new Request(`${BASE}?projectId=${progetto}`))).json()) as { current: { preset: string; rules: DesignRules } };
    // what the panel holds has no stackup in it: it could not send it back even if it wanted to
    expect(JSON.stringify(letto.current)).not.toContain("copperMm");
    await salva({ preset: letto.current.preset, rules: { ...letto.current.rules, minBoardEdgeClearanceMm: 0.5 } });
    const dopo = await scritto();
    expect(dopo.stackup).toEqual(ST_CAMERA);
    expect(dopo.rules).toMatchObject({ minTraceWidthMm: 0.15, minBoardEdgeClearanceMm: 0.5 });
  });

  it("piu' salvataggi di fila: la pila non si perde e non si raddoppia", async () => {
    await writeProjectFile(progetto, DESIGN_RULES_PATH, JSON.stringify({ preset: "jlcpcb_standard", stackup: ST_CAMERA }));
    for (const preset of ["oshpark", "jlcpcb_enhanced", "jlcpcb_standard", "oshpark"]) await salva({ preset });
    expect(await file()).toBe(`${JSON.stringify({ preset: "oshpark", stackup: ST_CAMERA }, null, 2)}\n`);
  });

  it("una pila scritta male resta com'era: il pannello delle regole non tocca quello che non salva", async () => {
    const sbagliata = { copperMm: [0.035, 0], dielectrics: [{ mm: 1.5 }] };
    await writeProjectFile(progetto, DESIGN_RULES_PATH, JSON.stringify({ preset: "oshpark", stackup: sbagliata }));
    await salva({ preset: "jlcpcb_enhanced" });
    expect(await scritto()).toEqual({ preset: "jlcpcb_enhanced", stackup: sbagliata });
  });
});

describe("un progetto senza pila si salva come prima", () => {
  it("il file scritto e' quello di sempre, alla lettera", async () => {
    await salva({ preset: "jlcpcb_enhanced" });
    expect(await file()).toBe('{\n  "preset": "jlcpcb_enhanced"\n}\n');
    await writeProjectFile(progetto, DESIGN_RULES_PATH, JSON.stringify({ preset: "custom", rules: { minTraceWidthMm: 0.15 } }));
    await salva({ preset: "oshpark" });
    expect(await file()).toBe('{\n  "preset": "oshpark"\n}\n');
  });

  it("la rotta del pannello non scrive una pila: uno stackup nel corpo della richiesta non entra nel file", async () => {
    await salva({ preset: "oshpark", stackup: ST_CAMERA });
    expect(await scritto()).toEqual({ preset: "oshpark" });
    // nor does it replace the one the project has
    await writeProjectFile(progetto, DESIGN_RULES_PATH, JSON.stringify({ preset: "oshpark", stackup: ST_CAMERA }));
    await salva({ preset: "jlcpcb_standard", stackup: { copperMm: [1, 1], dielectrics: [{ mm: 1 }] } });
    expect(await scritto()).toEqual({ preset: "jlcpcb_standard", stackup: ST_CAMERA });
  });
});
