import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * sbb-dl-principale, 12/11/2026. La scheda e' disegnata nei suoi file (regole
 * `autoroute: false`: ogni pista e' un <trace pcbPath>, ogni via un <via>). Il
 * giro n85 cambia un pezzo (U9 passa da 5 piedini a 3) e ridisegna il rame
 * attorno. Con la pagina aperta, "Aggiorna" (POST /api/compile) parte mentre
 * la scheda salvata e' ancora quella del giro prima: quella compilazione dava
 * a compileProject il rame della scheda salvata (keepCopperFrom) e carryCopper
 * lo riportava sulla geometria nuova. Alle 12:02:14 la scheda salvata aveva
 * 169 piste e 303 vie invece di 162 e 296: 7 piste e 7 vie del giro prima,
 * con gli stessi pcb_trace_id e pcb_via_id di quelle nuove, una sopra una
 * piazzola di U9.
 *
 * Perche' proprio quelle:
 *  - carryCopper riconosce il collegamento di una pista vecchia dagli id delle
 *    sue porte (source_port_N). Un pezzo con meno piedini rinumera tutte le
 *    porte dopo di lui: la pista vecchia non trova piu' il suo collegamento,
 *    passa per "rame di un collegamento che i file lasciano senza rame" e
 *    resta, se il suo percorso e' cambiato;
 *  - un collegamento che non c'e' piu' (U9.pin3 diventato U9.pin1) resta
 *    sempre;
 *  - un <via> spostato o tolto nei file resta sempre: non e' di nessuna pista.
 *
 * Il compile via MCP e quello dell'agente compilavano gia' dai soli file una
 * scheda cosi' (be75280, 09/11/2026); il pulsante della pagina no.
 */

const db = vi.hoisted(() => ({
  row: null as null | { filesHash: string; circuitJson: unknown[]; summary: unknown; createdAt: string; engineVersion: number; base?: unknown },
  files: {} as Record<string, string>,
  saves: [] as Array<{ hash: string; circuitJson: unknown[]; summary: unknown }>,
}));

vi.mock("@/lib/acl", () => ({ accessoDaRichiesta: vi.fn(async () => true) }));
vi.mock("@/lib/agent-tools", () => ({ withLibrary: vi.fn(async (f: Record<string, string>) => f) }));
vi.mock("@/lib/activity-store", () => ({ COMPILE_START: "compila la scheda", logActivity: vi.fn(async () => {}) }));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    getProject: vi.fn(async () => db.files),
    getCompileCache: vi.fn(async () => db.row),
    getCompileMeta: vi.fn(async () => (db.row ? { filesHash: db.row.filesHash, createdAt: db.row.createdAt, engineVersion: db.row.engineVersion, base: null } : null)),
    saveCompileCache: vi.fn(async (_p: string, hash: string, circuitJson: unknown[], summary: unknown) => {
      db.saves.push({ hash, circuitJson, summary });
      return { saved: true };
    }),
    saveRouteVariants: vi.fn(async () => {}),
  };
});

import { POST as compila } from "@/app/api/compile/route";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { filesHash } from "@/lib/project-store";

/** il giro prima: U9 a 5 piedini, due piste disegnate, una via di massa */
const PRIMA = `export default () => (
  <board width="40mm" height="24mm">
    <net name="GND" />
    <chip name="U9" footprint="sot23_5" pinLabels={{ pin1: "NC2", pin2: "NC1", pin3: "IO1", pin4: "GND", pin5: "IO2" }} pcbX={-10} pcbY={0} />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={0} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={10} pcbY={0} />
    <trace from=".U9 > .pin3" to=".R1 > .pin1" pcbPath={[{ x: 5, y: 3 }]} thickness="0.2mm" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPath={[{ x: 5, y: 4 }]} thickness="0.2mm" />
    <trace from=".U9 > .pin4" to="net.GND" />
    <via name="V1" pcbX={0} pcbY={-6} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
  </board>
)
`;
/** il giro dopo: U9 a 3 piedini e spostato, le due piste ridisegnate, la via spostata */
const DOPO = `export default () => (
  <board width="40mm" height="24mm">
    <net name="GND" />
    <chip name="U9" footprint="sot23" pinLabels={{ pin1: "IO1", pin2: "IO2", pin3: "GND" }} pcbX={-10} pcbY={1} />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={0} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={10} pcbY={0} />
    <trace from=".U9 > .pin1" to=".R1 > .pin1" pcbPath={[{ x: 5, y: -3 }]} thickness="0.2mm" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPath={[{ x: 5, y: -4 }]} thickness="0.2mm" />
    <trace from=".U9 > .pin3" to="net.GND" />
    <via name="V1" pcbX={3} pcbY={-6} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
  </board>
)
`;
const regole = (autoroute?: boolean) =>
  JSON.stringify({
    preset: "custom",
    rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, ...(autoroute === undefined ? {} : { autoroute }) },
  });
const fileDi = (main: string, autoroute?: boolean) => ({ "main.tsx": main, [DESIGN_RULES_PATH]: regole(autoroute) });

type El = Record<string, unknown> & { type: string };
const mm = (v: unknown) => Math.round(Number(v) * 1e4) / 1e4;
/** il rame di una scheda, per quello che e': il percorso di ogni pista e il posto di ogni via, in ordine */
const rame = (cj: unknown[]) => {
  const els = cj as El[];
  return {
    piste: els
      .filter((e) => e.type === "pcb_trace")
      .map((e) => ((e.route as Array<Record<string, unknown>> | undefined) ?? []).map((p) => `${mm(p.x)};${mm(p.y)}`).join(" > "))
      .sort(),
    vie: els
      .filter((e) => e.type === "pcb_via")
      .map((e) => `${mm(e.x)};${mm(e.y)}`)
      .sort(),
  };
};
/** gli id che compaiono su piu' di una pista o di una via */
const doppi = (cj: unknown[]) => {
  const visti = new Set<string>();
  const out: string[] = [];
  for (const e of cj as El[]) {
    if (e.type !== "pcb_trace" && e.type !== "pcb_via") continue;
    const id = String(e[`${e.type}_id`]);
    if (visti.has(id)) out.push(id);
    visti.add(id);
  }
  return out.sort();
};

describe("una scheda disegnata nei file (autoroute false) si compila dai soli file", () => {
  it("il rame della scheda salvata non torna: ne' le piste ridisegnate, ne' la via spostata", async () => {
    const prima = await compileProject(fileDi(PRIMA, false));
    expect(rame(prima.circuitJson).piste).toHaveLength(2);
    expect(rame(prima.circuitJson).vie).toHaveLength(1);

    const daiFile = await compileProject(fileDi(DOPO, false));
    expect(rame(daiFile.circuitJson).piste).toHaveLength(2);
    expect(rame(daiFile.circuitJson).vie).toHaveLength(1);
    // il giro dopo ha davvero ridisegnato tutto: niente del rame di prima e' rimasto dov'era
    expect(rame(daiFile.circuitJson).piste.filter((p) => rame(prima.circuitJson).piste.includes(p))).toEqual([]);
    expect(rame(daiFile.circuitJson).vie).not.toEqual(rame(prima.circuitJson).vie);

    // come "Aggiorna" dalla pagina: gli stessi file, con la scheda di prima in mano
    const aggiorna = await compileProject(fileDi(DOPO, false), { keepCopperFrom: prima.circuitJson });
    expect(rame(aggiorna.circuitJson)).toEqual(rame(daiFile.circuitJson));
    expect(doppi(aggiorna.circuitJson)).toEqual([]);
  }, 180_000);

  it("una pista tolta dai file non torna dalla scheda salvata", async () => {
    const prima = await compileProject(fileDi(PRIMA, false));
    const senzaUna = PRIMA.replace('    <trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPath={[{ x: 5, y: 4 }]} thickness="0.2mm" />\n', "");
    expect(senzaUna).not.toBe(PRIMA);
    const aggiorna = await compileProject(fileDi(senzaUna, false), { keepCopperFrom: prima.circuitJson });
    expect(rame(aggiorna.circuitJson).piste).toHaveLength(1);
    expect(rame(aggiorna.circuitJson).vie).toHaveLength(1);
  }, 180_000);
});

describe('"Aggiorna" dalla pagina (POST /api/compile) su una scheda disegnata nei file', () => {
  beforeEach(() => {
    db.row = null;
    db.files = {};
    db.saves = [];
  });

  it("con la scheda del giro prima ancora salvata, salva il rame dei file di adesso e nient'altro", async () => {
    const prima = await compileProject(fileDi(PRIMA, false));
    const daiFile = await compileProject(fileDi(DOPO, false));
    // la scheda salvata e' quella del giro prima; i file sono gia' quelli nuovi (li ha appena caricati l'agente)
    db.row = {
      filesHash: filesHash(fileDi(PRIMA, false)),
      circuitJson: prima.circuitJson,
      summary: prima.summary,
      createdAt: "2026-11-12T10:09:39.468Z",
      engineVersion: 11,
    };
    db.files = fileDi(DOPO, false);

    const risposta = await compila(
      new Request("http://localhost/api/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: "prova-piste-fantasma" }),
      }),
    );
    const flusso = await risposta.text();
    expect(flusso).toContain("event: fine");

    // la scheda salvata prima dello schematico e quella finale: tutte e due col solo rame dei file
    expect(db.saves.length).toBeGreaterThanOrEqual(2);
    for (const salvata of db.saves) {
      expect(salvata.hash).toBe(filesHash(fileDi(DOPO, false)));
      expect(rame(salvata.circuitJson)).toEqual(rame(daiFile.circuitJson));
      expect(doppi(salvata.circuitJson)).toEqual([]);
    }
    // e la finale ha il suo schematico
    expect((db.saves[db.saves.length - 1].circuitJson as El[]).some((e) => e.type === "schematic_component")).toBe(true);
  }, 240_000);
});
