import { describe, expect, it } from "vitest";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";

/*
 * Una scheda con del rame scritto nei file (una pista con pcbPath e due via
 * nel percorso, una via a se' sulla massa) e un collegamento senza rame, come
 * quelle che l'instradatore di una volta ha finito: "Aggiorna" ricompila senza
 * instradare e riporta il rame della compilazione prima (keepCopperFrom).
 *
 * Le regole NON dicono `autoroute: false`. Una scheda che lo dice e' disegnata
 * tutta nei suoi file e si compila dai soli file, senza riportare niente: vedi
 * compile-rame-solo-dai-file.test.ts (sbb-dl-principale, 12/11/2026).
 */
const MAIN = `export default () => (
  <board width="30mm" height="16mm">
    <net name="GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-6} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={6} pcbY={0} />
    <resistor name="R3" resistance="1k" footprint="0402" pcbX={0} pcbY={5} />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPathRelativeTo=".R1 > .pin2" pcbPath={[{x: 1, y: 0}, {x: 1, y: 0, via: true, fromLayer: "top", toLayer: "bottom"}, {x: 1, y: 0}, {x: 9, y: 0}, {x: 9, y: 0, via: true, fromLayer: "bottom", toLayer: "top"}, {x: 9, y: 0}]} thickness="0.3mm" />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R3 > .pin1" to=".R2 > .pin2" />
    <via name="V1" pcbX={0} pcbY={-4} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
  </board>
)
`;
const FILES = {
  "main.tsx": MAIN,
  [DESIGN_RULES_PATH]: JSON.stringify({
    preset: "custom",
    rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15 },
  }),
};

type El = Record<string, unknown> & { type: string };
const rame = (cj: unknown[]) => {
  const els = cj as El[];
  return {
    piste: els.filter((e) => e.type === "pcb_trace").length,
    via: els.filter((e) => e.type === "pcb_via").length,
  };
};
const ricompila = (prima: unknown[]) => compileProject(FILES, { route: false, keepCopperFrom: prima });
const idDelCollegamento = (cj: unknown[], nome: string) =>
  String((cj as El[]).find((e) => e.type === "source_trace" && e.display_name === nome)?.source_trace_id);

describe("ricompilare senza instradare non raddoppia il rame scritto nei file", () => {
  it("le piste e le via dei file non si sommano a quelle riportate: stessi conteggi a ogni ricompilazione", async () => {
    const prima = await compileProject(FILES, { route: false });
    const base = rame(prima.circuitJson);
    expect(base).toEqual({ piste: 1, via: 3 });

    let ultima = prima.circuitJson;
    for (let giro = 0; giro < 3; giro++) {
      ultima = (await ricompila(ultima)).circuitJson;
      expect(rame(ultima)).toEqual(base);
    }
  }, 120_000);

  it("una cache gia' raddoppiata torna al rame dei file", async () => {
    const prima = await compileProject(FILES, { route: false });
    const doppioni = (prima.circuitJson as El[]).filter((e) => e.type === "pcb_trace" || e.type === "pcb_via");
    const raddoppiata = [...prima.circuitJson, ...doppioni.map((e) => ({ ...e }))];
    expect(rame(raddoppiata)).toEqual({ piste: 2, via: 6 });

    expect(rame((await ricompila(raddoppiata)).circuitJson)).toEqual(rame(prima.circuitJson));
  }, 120_000);

  it("il rame riportato riempie solo i collegamenti che i file lasciano senza rame", async () => {
    const prima = await compileProject(FILES, { route: false });
    const scoperto = idDelCollegamento(prima.circuitJson, ".R3 > .pin1 to .R2 > .pin2");
    const scritto = idDelCollegamento(prima.circuitJson, ".R1 > .pin2 to .R2 > .pin1");
    const conRame = [
      ...prima.circuitJson,
      // il rame instradato di un collegamento che i file lasciano aperto: resta
      {
        type: "pcb_trace",
        pcb_trace_id: "pcb_trace_instradata",
        source_trace_id: scoperto,
        route: [
          { route_type: "wire", x: -0.5, y: 5, width: 0.2, layer: "top" },
          { route_type: "wire", x: 2, y: 5, width: 0.2, layer: "top" },
          { route_type: "via", x: 2, y: 5, from_layer: "top", to_layer: "bottom" },
          { route_type: "wire", x: 2, y: 5, width: 0.2, layer: "bottom" },
          { route_type: "wire", x: 6.5, y: 0, width: 0.2, layer: "bottom" },
        ],
      },
      { type: "pcb_via", pcb_via_id: "pcb_via_instradata", pcb_trace_id: "pcb_trace_instradata", x: 2, y: 5, hole_diameter: 0.3, outer_diameter: 0.6, layers: ["top", "bottom"] },
      // il rame vecchio di un collegamento che adesso i file disegnano altrove: va via, via compresa
      {
        type: "pcb_trace",
        pcb_trace_id: "pcb_trace_vecchia",
        source_trace_id: scritto,
        route: [
          { route_type: "wire", x: -5.5, y: 0, width: 0.2, layer: "top" },
          { route_type: "wire", x: -5.5, y: -2, width: 0.2, layer: "top" },
          { route_type: "via", x: -5.5, y: -2, from_layer: "top", to_layer: "bottom" },
          { route_type: "wire", x: 5.5, y: -2, width: 0.2, layer: "bottom" },
        ],
      },
      { type: "pcb_via", pcb_via_id: "pcb_via_vecchia", pcb_trace_id: "pcb_trace_vecchia", x: -5.5, y: -2, hole_diameter: 0.3, outer_diameter: 0.6, layers: ["top", "bottom"] },
    ];

    const dopo = (await ricompila(conRame)).circuitJson;
    expect(rame(dopo)).toEqual({ piste: 2, via: 4 });
    const riportate = (dopo as El[]).filter((e) => e.pcb_trace_id === "pcb_trace_instradata" && e.type === "pcb_trace");
    expect(riportate).toHaveLength(1);
    expect(riportate[0].source_trace_id).toBe(idDelCollegamento(dopo, ".R3 > .pin1 to .R2 > .pin2"));
    expect((dopo as El[]).some((e) => e.pcb_trace_id === "pcb_trace_vecchia" || e.pcb_via_id === "pcb_via_vecchia")).toBe(false);

    // e ricompilare ancora non cambia nulla
    expect(rame((await ricompila(dopo)).circuitJson)).toEqual({ piste: 2, via: 4 });
  }, 120_000);
});

/*
 * sbb-dl-principale, 12/11/2026 (n84 > n85): U9 passa da 5 piedini a 3 e ogni
 * porta dopo di lui cambia id (source_port_N): 155 dei 668 collegamenti con lo
 * stesso nome avevano le porte rinumerate. carryCopper riconosceva il
 * collegamento di una pista vecchia dagli id delle porte: non lo ritrovava
 * piu', o ne trovava un altro che per caso aveva quegli id. Li' la scheda e'
 * disegnata nei file e ora non riporta niente; qui la stessa cosa su una
 * scheda che il rame lo riporta ancora.
 */
const PEZZI = (u9: string, prima: string, pista: string) => `export default () => (
  <board width="40mm" height="24mm">
    ${u9}
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-2} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={6} pcbY={0} />
    <resistor name="R3" resistance="1k" footprint="0402" pcbX={2} pcbY={6} />
    ${prima}<trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPath={[{ x: 4, y: ${pista} }]} thickness="0.2mm" />
    <trace from=".R3 > .pin1" to=".R2 > .pin2" />
  </board>
)
`;
const CINQUE = PEZZI(
  '<chip name="U9" footprint="sot23_5" pinLabels={{ pin1: "NC2", pin2: "NC1", pin3: "IO1", pin4: "GND", pin5: "IO2" }} pcbX={-12} pcbY={0} />',
  "",
  "3",
);
// U9 a 3 piedini (le porte di R1, R2, R3 cambiano id), un collegamento in piu' prima degli altri
// (cambiano id anche i collegamenti) e la pista R1-R2 ridisegnata dall'altra parte
const TRE = PEZZI(
  '<chip name="U9" footprint="sot23" pinLabels={{ pin1: "IO1", pin2: "IO2", pin3: "GND" }} pcbX={-12} pcbY={0} />',
  '<trace from=".U9 > .pin1" to=".R1 > .pin1" />\n    ',
  "-3",
);
const REGOLE_RIPORTO = JSON.stringify({ preset: "custom", rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15 } });
const percorsi = (cj: unknown[]) =>
  (cj as El[])
    .filter((e) => e.type === "pcb_trace")
    .map((e) => `${String(e.pcb_trace_id)}: ${((e.route as Array<{ x: number; y: number }> | undefined) ?? []).map((p) => `${Math.round(p.x * 100) / 100};${Math.round(p.y * 100) / 100}`).join(" > ")}`)
    .sort();

describe("il rame riportato ritrova il suo collegamento anche quando le porte cambiano id", () => {
  it("un pezzo con meno piedini: la pista ridisegnata non resta in doppio e il rame instradato resta sul suo collegamento", async () => {
    const prima = await compileProject({ "main.tsx": CINQUE, [DESIGN_RULES_PATH]: REGOLE_RIPORTO }, { route: false });
    expect(percorsi(prima.circuitJson)).toHaveLength(1);
    const aperto = ".R3 > .pin1 to .R2 > .pin2";
    const salvata = [
      ...prima.circuitJson,
      // il rame instradato del collegamento che i file lasciano aperto
      {
        type: "pcb_trace",
        pcb_trace_id: "pcb_trace_instradata",
        source_trace_id: idDelCollegamento(prima.circuitJson, aperto),
        route: [
          { route_type: "wire", x: 1.5, y: 6, width: 0.2, layer: "top" },
          { route_type: "wire", x: 6.5, y: 6, width: 0.2, layer: "top" },
          { route_type: "wire", x: 6.5, y: 0, width: 0.2, layer: "top" },
        ],
      },
    ];

    const dopo = (await compileProject({ "main.tsx": TRE, [DESIGN_RULES_PATH]: REGOLE_RIPORTO }, { route: false, keepCopperFrom: salvata })).circuitJson;
    const daiFile = (await compileProject({ "main.tsx": TRE, [DESIGN_RULES_PATH]: REGOLE_RIPORTO }, { route: false })).circuitJson;
    // i collegamenti hanno davvero cambiato id, e le porte pure
    expect(idDelCollegamento(dopo, aperto)).not.toBe(idDelCollegamento(prima.circuitJson, aperto));

    // la pista dei file, una volta sola, e quella instradata: la pista vecchia di R1-R2 non c'e' piu'
    expect(percorsi(dopo)).toEqual([...percorsi(daiFile), "pcb_trace_instradata: 1.5;6 > 6.5;6 > 6.5;0"].sort());
    // e il rame instradato e' ancora del suo collegamento, col suo id di adesso
    const instradata = (dopo as El[]).find((e) => e.pcb_trace_id === "pcb_trace_instradata");
    expect(instradata?.source_trace_id).toBe(idDelCollegamento(dopo, aperto));
  }, 120_000);
});
