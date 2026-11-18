import { describe, expect, it } from "vitest";
import { convertSoupToGerberCommands, stringifyGerberCommandLayers } from "circuit-json-to-gerber";
import { buildScene, centroDelDisegno } from "@/components/board/render";
import {
  BORDO_FLESSIBILE_MM,
  bordoDelFlessibile,
  DEFAULT_DESIGN_RULES,
  distanzaForoFlessibile,
  FORO_FLESSIBILE_MM,
  raggioDiPiegaPerSpessore,
  validaFileDelleRegole,
  type DesignRules,
} from "@/lib/design-rules";
import { runDrcChecks, type DrcViolation } from "@/lib/drc";
import {
  avvisiDelFlessibile,
  circuitoSenzaFlessibile,
  comandiConIlFlessibile,
  conFlessibile,
  DESCRIZIONE_FLEX,
  ESEMPIO_FLEX,
  FILE_COVERLAY,
  FILE_IRRIGIDITORI,
  FILE_MECCANICO,
  FILE_PILA,
  fileDelFlessibile,
  FLEX_PATH,
  leggiFlex,
  MAX_PIEGHE,
  MAX_VERTICI_FLEX,
  MAX_ZONE,
  ostacoliDelFlessibile,
  schedaDelFlessibile,
  validaFileDelFlessibile,
} from "@/lib/flex";
import { ANELLO_DEL_RETINO, conRetino, MAX_APERTURE_RETINO, senzaRetino } from "@/lib/flex-retino";
import { flessibileDellaScheda, mezzaFasciaDellaPiega } from "@/lib/flex-zone";
import { comandiConLaMaschera } from "@/lib/solder-mask";

/*
 * RIGID-FLEX BOARDS (flex.json).
 *
 * The scene: a rigid board 20 x 20 mm (x and y from -10 to 10), four layers,
 * with a flexible tail 12 mm wide and 20 mm long that leaves its bottom edge
 * (y = -10) between x = -6 and x = 6 and ends at y = -30. One outline for the
 * whole piece. The tail has ONE copper layer, inner1, and is 0,1 mm thick; it
 * folds back over the board by 180 degrees on a line 4 mm below the edge
 * (y = -14) with 1 mm of inner radius: the bend takes pi x 1,05 = 3,30 mm of
 * tail, from y = -12,35 to y = -15,65. That is the tail of the modem boards of
 * Wildy, smaller.
 */
type El = Record<string, unknown> & { type: string };
type Punto = { x: number; y: number };

const CONTORNO: Punto[] = [
  { x: -10, y: -10 },
  { x: -6, y: -10 },
  { x: -6, y: -30 },
  { x: 6, y: -30 },
  { x: 6, y: -10 },
  { x: 10, y: -10 },
  { x: 10, y: 10 },
  { x: -10, y: 10 },
];
const BOARD: El = { type: "pcb_board", pcb_board_id: "b1", center: { x: 0, y: -10 }, width: 20, height: 40, num_layers: 4, thickness: 1.6, outline: CONTORNO };
const CODA: Punto[] = [
  { x: -6, y: -10 },
  { x: 6, y: -10 },
  { x: 6, y: -30 },
  { x: -6, y: -30 },
];
const rettangolo = (x1: number, y1: number, x2: number, y2: number): Punto[] => [
  { x: x1, y: y1 },
  { x: x2, y: y1 },
  { x: x2, y: y2 },
  { x: x1, y: y2 },
];

const PILA = { spessoreMm: 0.1, coverlay: "giallo" };
const PIEGA = { nome: "ripiega", da: { x: -6, y: -14 }, a: { x: 6, y: -14 }, raggioMm: 1, angolo: 180, verso: "su" };
const zona = (altro: Record<string, unknown> = {}) => ({ nome: "coda", strati: ["inner1"], punti: CODA, ...altro });
/** the file of the scene: one zone, one bend */
const FLEX = { pila: PILA, zone: [zona()], pieghe: [PIEGA] };
const file = (corpo: unknown) => ({ [FLEX_PATH]: JSON.stringify(corpo) });

const SCHEDA = { contorno: CONTORNO, strati: ["top", "inner1", "inner2", "bottom"] };

/** two nets and their ports: GND (k1) and SIG (k2) */
function scena(...altri: El[][]): El[] {
  const tutti = altri.flat();
  const porte = (k: string) => tutti.filter((e) => e.type === "source_port" && e.subcircuit_connectivity_map_key === k).map((e) => e.source_port_id);
  return [
    BOARD,
    { type: "source_net", source_net_id: "n1", name: "GND", subcircuit_connectivity_map_key: "k1" },
    { type: "source_net", source_net_id: "n2", name: "SIG", subcircuit_connectivity_map_key: "k2" },
    { type: "source_trace", source_trace_id: "st1", subcircuit_connectivity_map_key: "k1", connected_source_port_ids: porte("k1"), connected_source_net_ids: ["n1"] },
    { type: "source_trace", source_trace_id: "st2", subcircuit_connectivity_map_key: "k2", connected_source_port_ids: porte("k2"), connected_source_net_ids: ["n2"] },
    ...tutti,
  ];
}

function parte(nome: string, x: number, y: number, layer = "top"): El[] {
  return [
    { type: "source_component", source_component_id: `sc_${nome}`, name: nome },
    { type: "pcb_component", pcb_component_id: nome, source_component_id: `sc_${nome}`, center: { x, y }, layer, rotation: 0, width: 1, height: 1 },
  ];
}

function piazzola(comp: string, pin: string, x: number, y: number, layer = "top", rete: "k1" | "k2" = "k1"): El[] {
  const id = `${comp}_${pin}`;
  return [
    { type: "source_port", source_port_id: `sp_${id}`, name: pin, source_component_id: `sc_${comp}`, subcircuit_connectivity_map_key: rete },
    { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, pcb_component_id: comp, x, y, layers: [layer] },
    { type: "pcb_smtpad", pcb_smtpad_id: `pad_${id}`, pcb_component_id: comp, pcb_port_id: `pp_${id}`, layer, shape: "rect", x, y, width: 0.6, height: 0.6, soldermask_margin: 0.05 },
  ];
}

function foro(comp: string, pin: string, x: number, y: number, esterno = 1.8, punta = 1.0): El[] {
  const id = `${comp}_${pin}`;
  return [
    { type: "source_port", source_port_id: `sp_${id}`, name: pin, source_component_id: `sc_${comp}`, subcircuit_connectivity_map_key: "k1" },
    { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, pcb_component_id: comp, x, y, layers: ["top", "bottom"] },
    { type: "pcb_plated_hole", pcb_plated_hole_id: `ph_${id}`, pcb_component_id: comp, pcb_port_id: `pp_${id}`, shape: "circle", x, y, outer_diameter: esterno, hole_diameter: punta, layers: ["top", "bottom"] },
  ];
}

const via = (id: string, x: number, y: number, d = 0.5): El[] => [
  { type: "pcb_via", pcb_via_id: id, x, y, outer_diameter: d, hole_diameter: 0.2, layers: ["top", "inner1", "inner2", "bottom"], subcircuit_connectivity_map_key: "k1" },
];

const pista = (id: string, layer: string, punti: Punto[], width = 0.2): El[] => [
  { type: "pcb_trace", pcb_trace_id: id, source_trace_id: "st2", route: punti.map((p) => ({ route_type: "wire", x: p.x, y: p.y, width, layer })) },
];

const colata = (id: string, layer: string, esterno: Punto[], buchi: Punto[][] = []): El[] => [
  {
    type: "pcb_copper_pour",
    pcb_copper_pour_id: id,
    layer,
    source_net_id: "n1",
    shape: "brep",
    brep_shape: { outer_ring: { vertices: esterno }, inner_rings: buchi.map((b) => ({ vertices: b })) },
  },
];

/** the board as the compile leaves it: what the file says, on it */
const conFile = (els: El[], corpo: unknown = FLEX) => conFlessibile(els, file(corpo));
const drc = (els: El[], rules: DesignRules = DEFAULT_DESIGN_RULES) => runDrcChecks(els as never, rules).filter((v) => v.rule.startsWith("flex_"));
const diRegola = (v: DrcViolation[], regola: string) => v.filter((x) => x.rule === regola);
const messaggi = (v: DrcViolation[]) => v.map((x) => x.message).join(" | ");

describe("flex.json, checked whole when it is written", () => {
  const valida = (corpo: unknown, scheda: typeof SCHEDA | undefined = SCHEDA) =>
    validaFileDelFlessibile(typeof corpo === "string" ? corpo : JSON.stringify(corpo), scheda);

  it("the file of the scene is right: a one-layer tail, a fold of 180 degrees", () => {
    const esito = valida(FLEX);
    if ("errori" in esito) throw new Error(esito.errori.join("; "));
    expect(esito.flex.zone).toEqual([{ indice: 0, nome: "coda", punti: CODA, strati: ["inner1"], finestre: [], ritagli: [] }]);
    expect(esito.flex.pieghe).toEqual([{ indice: 0, nome: "ripiega", a: PIEGA.da, b: PIEGA.a, raggioMm: 1, angolo: 180, verso: "su" }]);
    expect(esito.flex.pila).toEqual({ spessoreMm: 0.1, coverlay: "giallo", materiali: [] });
  });

  it("the example the tools show is a right file: one layer, 37 mm wide, 180 degrees, a window, a cutout, a stiffener", () => {
    // the modem board of Wildy, 42,5 x 51,5, and the tail of the example under its bottom edge
    const contorno = [
      { x: -21.25, y: -25.75 },
      { x: -18.5, y: -25.75 },
      { x: -18.5, y: -60.75 },
      { x: 18.5, y: -60.75 },
      { x: 18.5, y: -25.75 },
      { x: 21.25, y: -25.75 },
      { x: 21.25, y: 25.75 },
      { x: -21.25, y: 25.75 },
    ];
    const esito = validaFileDelFlessibile(JSON.stringify(ESEMPIO_FLEX), { contorno, strati: SCHEDA.strati });
    if ("errori" in esito) throw new Error(esito.errori.join("; "));
    const [z] = esito.flex.zone;
    expect(z.strati).toEqual(["inner1"]);
    expect(Math.max(...z.punti.map((p) => p.x)) - Math.min(...z.punti.map((p) => p.x))).toBe(37);
    expect(z.finestre.map((f) => f.nome)).toEqual(["antenna LTE"]);
    expect(z.ritagli.map((f) => f.nome)).toEqual(["asola vite"]);
    expect(esito.flex.pieghe[0]).toMatchObject({ angolo: 180, raggioMm: 1, verso: "su" });
    // its ground is a grid where it bends, a millimetre beyond the curve unless the file says otherwise
    expect(z.retino).toEqual({ larghezzaMm: 0.3, passoMm: 0.8, angolo: 45, dove: "piega", margineMm: 1 });
    expect(esito.flex.pila?.spessoreMm).toBe(0.1);
    expect(esito.flex.irrigiditori).toHaveLength(1);
    expect(esito.flex.aperture).toHaveLength(1);
    // the stack of the example adds up to its thickness
    expect(ESEMPIO_FLEX.pila.materiali.reduce((t, m) => t + m.mm, 0)).toBeCloseTo(0.098, 6);
    // and it is in the text an agent reads, whole
    expect(DESCRIZIONE_FLEX).toContain(JSON.stringify(ESEMPIO_FLEX));
    // on the board of the example no check of the zones fires: the bend is 10 times the thickness and starts 1,35 mm past the rigid part
    const scheda: El[] = [{ ...BOARD, center: { x: 0, y: 0 }, width: 42.5, height: 51.5, outline: contorno }];
    const cj = conFlessibile(scheda, { [FLEX_PATH]: JSON.stringify(ESEMPIO_FLEX) });
    expect(drc(cj)).toEqual([]);
  });

  it("a wrong file is refused with the reason, and nothing of what was sent comes back", () => {
    const tanti = (n: number) => Array.from({ length: n }, (_, i) => ({ x: Math.cos((i * 2 * Math.PI) / n), y: -20 + Math.sin((i * 2 * Math.PI) / n) }));
    const casi: Array<[unknown, RegExp]> = [
      ["{ zone: [", /non e' un JSON valido/],
      [[FLEX], /serve un oggetto/],
      [{ ...FLEX, scorciatoia: 1 }, /campo sconosciuto scorciatoia \(ammessi pila, zone, pieghe, irrigiditori, coverlay\)/],
      [{ ...FLEX, "<script>alert(1)</script>": 1 }, /campo sconosciuto dal nome non valido/],
      [{ zone: [zona()] }, /pila: manca/],
      [{ ...FLEX, pila: { ...PILA, spessoreMm: 5 } }, /pila\.spessoreMm: .* da 0\.05 a 1/],
      [{ ...FLEX, pila: { ...PILA, spessoreMm: "0.1" } }, /pila\.spessoreMm/],
      [{ ...FLEX, pila: { ...PILA, coverlay: "verde" } }, /pila\.coverlay: deve essere uno di giallo, bianco, nero, nessuno/],
      [{ ...FLEX, pila: { ...PILA, materiali: [{ tipo: "rame", mm: 0.018, er: 3 }] } }, /pila\.materiali\[0\]: un campo sconosciuto/],
      [{ ...FLEX, pila: { ...PILA, materiali: [{ tipo: "oro", mm: 0.018 }] } }, /pila\.materiali\[0\]\.tipo/],
      [{ pila: PILA, zone: [] }, /zone: serve un elenco con almeno una zona/],
      [{ pila: PILA }, /zone: serve un elenco con almeno una zona/],
      [{ pila: PILA, zone: Array.from({ length: MAX_ZONE + 1 }, (_, i) => zona({ nome: `z${i}` })) }, new RegExp(`zone: troppe \\(${MAX_ZONE + 1}, massimo ${MAX_ZONE}\\)`)],
      [{ pila: PILA, zone: [zona({ punti: tanti(MAX_VERTICI_FLEX + 1) })] }, new RegExp(`zone\\[0\\]\\.punti: serve un elenco da 3 a ${MAX_VERTICI_FLEX} vertici`)],
      [{ pila: PILA, zone: [zona({ punti: [CODA[0], CODA[1]] })] }, /zone\[0\]\.punti: serve un elenco da 3 a/],
      [`{"pila": ${JSON.stringify(PILA)}, "zone": [{"nome": "coda", "strati": ["inner1"], "punti": [{"x": 1e999, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}]}]}`, /zone\[0\]\.punti: ogni vertice e'/],
      [{ pila: PILA, zone: [zona({ punti: [{ x: "0", y: 0 }, CODA[1], CODA[2]] })] }, /zone\[0\]\.punti: ogni vertice e'/],
      [{ pila: PILA, zone: [zona({ punti: [{ x: 5000, y: 0 }, CODA[1], CODA[2]] })] }, /zone\[0\]\.punti: ogni vertice e'/],
      [{ pila: PILA, zone: [zona({ punti: [{ x: 0, y: 0, z: 1 }, CODA[1], CODA[2]] })] }, /zone\[0\]\.punti: ogni vertice e'/],
      [{ pila: PILA, zone: [zona({ punti: [CODA[0], CODA[2], CODA[1], CODA[3]] })] }, /zone\[0\]\.punti: due lati del poligono si incrociano/],
      [{ pila: PILA, zone: [zona({ strati: [] })] }, /zone\[0\]\.strati/],
      [{ pila: PILA, zone: [zona({ strati: ["inner1", "inner1"] })] }, /zone\[0\]\.strati/],
      [{ pila: PILA, zone: [zona({ strati: ["rame"] })] }, /zone\[0\]\.strati/],
      [{ pila: PILA, zone: [zona({ strati: ["inner3"] })] }, /zone\[0\]\.strati: la scheda ha gli strati top, inner1, inner2, bottom/],
      [{ pila: PILA, zone: [zona({ nome: '<img src=x onerror="alert(1)">' })] }, /zone\[0\]\.nome: un testo da 1 a 60 caratteri/],
      [{ pila: PILA, zone: [{ strati: ["inner1"], punti: CODA }] }, /zone\[0\]\.nome: manca/],
      [{ pila: PILA, zone: [zona(), zona({ punti: rettangolo(-4, -20, 4, -12) })] }, /zone\[1\]\.nome: un'altra zona ha lo stesso nome/],
      [{ pila: PILA, zone: [zona(), zona({ nome: "altra", punti: rettangolo(-4, -20, 4, -12) })] }, /zone\[1\]: si sovrappone a un'altra zona/],
      // a zone that leaves the outline of the board: wider than the tail, and one below its end
      [{ pila: PILA, zone: [zona({ punti: rettangolo(-8, -30, 8, -10) })] }, /zone\[0\]: esce dal contorno della scheda dell'ultima compilazione/],
      [{ pila: PILA, zone: [zona({ punti: rettangolo(-6, -35, 6, -10) })] }, /zone\[0\]: esce dal contorno della scheda/],
      [{ pila: PILA, zone: [zona({ finestre: [{ punti: rettangolo(-8, -20, 0, -15) }] })] }, /zone\[0\]\.finestre\[0\]: deve stare tutto nella sua zona/],
      [{ pila: PILA, zone: [zona({ ritagli: [{ punti: rettangolo(0, -32, 2, -28) }] })] }, /zone\[0\]\.ritagli\[0\]: deve stare tutto nella sua zona/],
      [{ pila: PILA, zone: [zona({ ritagli: "tutti" })] }, /zone\[0\]\.ritagli: serve un elenco/],
      // a bend of a zone that was refused is not said twice: the reason is the zone's
      [{ ...FLEX, zone: [zona({ strati: ["rame"] })] }, /^zone\[0\]\.strati: [^;]*$/],
      [{ ...FLEX, pieghe: [{ ...PIEGA, da: { x: -8, y: -14 } }] }, /pieghe\[0\]: la linea di piega deve stare tutta in una zona flessibile/],
      [{ ...FLEX, pieghe: [{ ...PIEGA, da: { x: -6, y: -5 }, a: { x: 6, y: -5 } }] }, /pieghe\[0\]: la linea di piega deve stare tutta in una zona flessibile/],
      [{ ...FLEX, pieghe: [{ ...PIEGA, angolo: 200 }] }, /pieghe\[0\]\.angolo: .* fino a 180/],
      [{ ...FLEX, pieghe: [{ ...PIEGA, angolo: 0 }] }, /pieghe\[0\]\.angolo/],
      [{ ...FLEX, pieghe: [{ ...PIEGA, raggioMm: 0 }] }, /pieghe\[0\]\.raggioMm/],
      [{ ...FLEX, pieghe: [{ ...PIEGA, verso: "sinistra" }] }, /pieghe\[0\]\.verso: deve essere "su"/],
      [{ ...FLEX, pieghe: Array.from({ length: MAX_PIEGHE + 1 }, () => PIEGA) }, new RegExp(`pieghe: troppe \\(${MAX_PIEGHE + 1}, massimo ${MAX_PIEGHE}\\)`)],
      [{ ...FLEX, irrigiditori: [{ lato: "top", materiale: "legno", spessoreMm: 0.2, punti: rettangolo(-4, -29, 4, -25) }] }, /irrigiditori\[0\]\.materiale: deve essere uno di poliimmide, fr4, acciaio, alluminio/],
      [{ ...FLEX, irrigiditori: [{ lato: "top", materiale: "fr4", spessoreMm: 2, punti: rettangolo(-4, -29, 4, -25) }] }, /irrigiditori\[0\]\.spessoreMm: per questo materiale PCB Basic fa spessori da 0\.1 a 1\.6 mm/],
      [{ ...FLEX, irrigiditori: [{ lato: "sopra", materiale: "fr4", spessoreMm: 0.2, punti: rettangolo(-4, -29, 4, -25) }] }, /irrigiditori\[0\]\.lato/],
      [{ ...FLEX, irrigiditori: [{ lato: "top", materiale: "fr4", spessoreMm: 0.2, punti: rettangolo(-4, -29, 4, -25), fori: [{ x: 3.5, y: -27, diametroMm: 2 }] }] }, /irrigiditori\[0\]\.fori/],
      [{ ...FLEX, irrigiditori: [{ lato: "top", materiale: "fr4", spessoreMm: 0.2, punti: rettangolo(-4, -40, 4, -25) }] }, /irrigiditori\[0\]: esce dal contorno della scheda/],
      [{ ...FLEX, coverlay: { top: [{ punti: rettangolo(-1, -5, 1, -3) }] } }, /coverlay\.top\[0\]: un'apertura del coverlay sta tutta in una zona flessibile/],
      [{ ...FLEX, coverlay: { sinistra: [] } }, /coverlay: campo sconosciuto sinistra/],
      // a word every object has is not a word of the file
      [{ ...FLEX, pila: { ...PILA, coverlay: "constructor" } }, /pila\.coverlay: deve essere uno di giallo, bianco, nero, nessuno/],
      [{ ...FLEX, pila: { ...PILA, coverlay: "__proto__" } }, /pila\.coverlay/],
      [{ ...FLEX, pila: { ...PILA, materiali: [{ tipo: "toString", mm: 0.018 }] } }, /pila\.materiali\[0\]\.tipo/],
      [{ ...FLEX, irrigiditori: [{ lato: "top", materiale: "constructor", spessoreMm: 0.2, punti: rettangolo(-4, -29, 4, -25) }] }, /irrigiditori\[0\]\.materiale/],
      [{ ...FLEX, irrigiditori: [{ lato: "top", materiale: "hasOwnProperty", spessoreMm: 0.2, punti: rettangolo(-4, -29, 4, -25) }] }, /irrigiditori\[0\]\.materiale/],
    ];
    for (const [corpo, atteso] of casi) {
      const esito = valida(corpo);
      expect("errori" in esito, String(atteso)).toBe(true);
      if (!("errori" in esito)) continue;
      const testo = esito.errori.join("; ");
      expect(testo).toMatch(atteso);
      expect(testo).not.toMatch(/<script|<img|onerror|alert/);
    }
  });

  it("without a compiled board the outline is not asked, the rest is", () => {
    // off the outline of the scene, but there is no board to say so yet
    expect("flex" in validaFileDelFlessibile(JSON.stringify({ pila: PILA, zone: [zona({ punti: rettangolo(-8, -30, 8, -10) })] }))).toBe(true);
    expect("errori" in validaFileDelFlessibile(JSON.stringify({ pila: PILA, zone: [zona({ strati: ["rame"] })] }))).toBe(true);
  });

  it("the board a file is checked against is read from its circuit: outline and copper layers", () => {
    expect(schedaDelFlessibile([BOARD])).toEqual(SCHEDA);
    expect(schedaDelFlessibile([{ type: "pcb_board", center: { x: 0, y: 0 }, width: 10, height: 4 }])?.strati).toEqual(["top", "bottom"]);
    expect(schedaDelFlessibile([])).toBeUndefined();
    expect(schedaDelFlessibile(null)).toBeUndefined();
  });
});

describe("what the file says, on the board", () => {
  const COMPLETO = {
    pila: { ...PILA, materiali: [{ tipo: "rame", nome: "RA 18um", mm: 0.018 }] },
    zone: [zona({ finestre: [{ nome: "antenna", punti: rettangolo(-5, -28, -1, -22) }], ritagli: [{ nome: "asola", punti: rettangolo(2, -27, 4, -24) }] })],
    pieghe: [PIEGA],
    irrigiditori: [{ nome: "rinforzo", lato: "bottom", materiale: "poliimmide", spessoreMm: 0.2, punti: rettangolo(-5.5, -29.5, 5.5, -20), fori: [{ x: 0, y: -21, diametroMm: 1 }] }],
    coverlay: { top: [{ nome: "contatto", punti: rettangolo(-1, -20, 1, -18) }], bottom: [] },
  };

  it("is put there by the compile, each thing an element of its own, after everything else", () => {
    const cj = conFile(scena(), COMPLETO);
    expect(cj.slice(0, scena().length)).toEqual(scena());
    const nuovi = cj.slice(scena().length);
    expect(nuovi.map((e) => e.type)).toEqual(["pcb_flex_zone", "pcb_cutout", "pcb_flex_bend", "pcb_flex_stiffener", "pcb_flex_coverlay_opening", "pcb_flex_stackup"]);
    expect(nuovi[0]).toMatchObject({ pcb_flex_zone_id: "pcb_flex_zone_0", nome: "coda", layers: ["inner1"], points: CODA });
    expect(nuovi[0].windows).toEqual([{ nome: "antenna", points: rettangolo(-5, -28, -1, -22) }]);
    // a cutout of the tail is a cutout of the board: the outline of the Gerber has it
    expect(nuovi[1]).toEqual({ type: "pcb_cutout", pcb_cutout_id: "pcb_cutout_flessibile_0_0", shape: "polygon", points: rettangolo(2, -27, 4, -24) });
    expect(nuovi[2]).toMatchObject({ from: PIEGA.da, to: PIEGA.a, radius_mm: 1, angle_deg: 180, direction: "su" });
    expect(nuovi[5]).toMatchObject({ thickness_mm: 0.1, coverlay: "giallo" });
  });

  it("is read back with the sides of the zone told apart: the edge of the board, and the line where the rigid part ends", () => {
    const flex = flessibileDellaScheda(conFile(scena(), COMPLETO))!;
    const [z] = flex.zone;
    // the side along y = -10 is inside the board: the rigid part ends there
    expect(z.confini).toHaveLength(1);
    expect(z.confini[0]).toMatchObject({ ay: -10, by: -10 });
    expect(Math.abs(z.confini[0].bx - z.confini[0].ax)).toBeCloseTo(12, 6);
    // the other three are the cut of the tail, and so are the four sides of its cutout
    expect(z.bordi).toHaveLength(3 + 4);
    expect(z.finestre.map((f) => f.nome)).toEqual(["antenna"]);
    expect(z.ritagli.map((f) => f.nome)).toEqual(["asola"]);
    // a fold of 180 degrees at 1 mm on a tail 0,1 mm thick: pi x 1,05 of tail, half on each side of the line
    const [p] = flex.pieghe;
    expect(p.mezzaFasciaMm).toBeCloseTo((Math.PI * 1.05) / 2, 9);
    expect(mezzaFasciaDellaPiega(1, 180, 0.1)).toBeCloseTo(1.6493, 4);
    expect(Math.min(...p.fascia.map((q) => q.y))).toBeCloseTo(-14 - 1.6493, 4);
    expect(Math.max(...p.fascia.map((q) => q.y))).toBeCloseTo(-14 + 1.6493, 4);
    expect(p.zona).toBe(z);
    expect(flex.irrigiditori[0]).toMatchObject({ lato: "bottom", materiale: "poliimmide", spessoreMm: 0.2, fori: [{ x: 0, y: -21, diametroMm: 1 }] });
    expect(flex.pila).toMatchObject({ spessoreMm: 0.1 });
  });

  it("a tail narrower than the side it is written on: the side is split where the outline leaves it", () => {
    // the zone drawn 2 mm into the rigid part: its upper side is inside the board, its flanks are edge only below y = -10
    const flex = flessibileDellaScheda(conFile(scena(), { pila: PILA, zone: [zona({ punti: rettangolo(-6, -30, 6, -8) })] }))!;
    const [z] = flex.zone;
    const lunghezza = (lati: Array<{ ax: number; ay: number; bx: number; by: number }>) => lati.reduce((t, l) => t + Math.hypot(l.bx - l.ax, l.by - l.ay), 0);
    expect(lunghezza(z.bordi)).toBeCloseTo(20 + 12 + 20, 6);
    expect(lunghezza(z.confini)).toBeCloseTo(2 + 12 + 2, 6);
  });

  it("a project without the file gets its board back as it is, the same array", () => {
    const cj = scena();
    expect(conFlessibile(cj, {})).toBe(cj);
    expect(flessibileDellaScheda(cj)).toBeNull();
    expect(ostacoliDelFlessibile(cj, {}, 0.3, 0.25)).toBeUndefined();
    expect(avvisiDelFlessibile(cj, {})).toEqual([]);
    expect(fileDelFlessibile(cj, {}, "p")).toEqual({});
    expect(circuitoSenzaFlessibile(cj)).toBeNull();
  });

  it("the file taken away takes its elements off the board, the cutouts too", () => {
    const con = conFile(scena(), COMPLETO);
    expect(conFlessibile(con, {})).toEqual(scena());
    // and written again, they are not there twice
    expect(conFile(con, COMPLETO)).toEqual(con);
    // a cutout the board has of its own stays
    const suo: El = { type: "pcb_cutout", pcb_cutout_id: "pcb_cutout_0", shape: "rect", center: { x: 0, y: 0 }, width: 2, height: 2 };
    expect(conFlessibile([...con, suo], {})).toEqual([...scena(), suo]);
  });

  it("a zone off the outline of the board is not put on it, and the checks say so", () => {
    const fuori = { pila: PILA, zone: [zona({ punti: rettangolo(-8, -30, 8, -10) })], pieghe: [PIEGA] };
    const cj = conFile(scena(), fuori);
    expect(cj).toEqual(scena());
    const avvisi = avvisiDelFlessibile(cj, file(fuori));
    expect(avvisi[0].message).toContain("la zona «coda» esce dal contorno della scheda: non e' stata messa");
    expect(avvisi[0].message).toContain("<board outline>");
    expect(avvisi.map((a) => a.message).join(" ")).toContain("la piega «ripiega» non sta in una zona messa sulla scheda");
  });

  it("a file that cannot be read is said and the board stays rigid", () => {
    expect(leggiFlex({ [FLEX_PATH]: "{" })).toEqual({ flex: null, avvisi: [`${FLEX_PATH} non e' un JSON valido: ignorato, la scheda e' trattata come rigida`] });
    expect(conFlessibile(scena(), { [FLEX_PATH]: "{" })).toEqual(scena());
    expect(avvisiDelFlessibile(scena(), { [FLEX_PATH]: "{" })).toHaveLength(1);
  });

  it("what the fab does not offer is a warning: three copper layers, a tail thinner than 0,08", () => {
    const tre = { pila: { ...PILA, spessoreMm: 0.06 }, zone: [zona({ strati: ["top", "inner1", "inner2"] })] };
    const testo = avvisiDelFlessibile(conFile(scena(), tre), file(tre)).map((a) => a.message).join(" | ");
    expect(testo).toContain("la zona «coda» ha 3 strati di rame: PCB Basic fa parti flessibili a 1, 2, 4, 6, 8, 10 strati");
    expect(testo).toContain("pila.spessoreMm 0.06: la parte flessibile piu' sottile di PCB Basic e' 0.08 mm");
    expect(avvisiDelFlessibile(conFile(scena()), file(FLEX))).toEqual([]);
  });

  it("the viewer gets it with the board: zones, bends and stiffeners", () => {
    const scene = buildScene(conFile(scena(), COMPLETO))!;
    expect(scene.flessibile?.zone.map((z) => z.nome)).toEqual(["coda"]);
    expect(scene.flessibile?.pieghe.map((p) => p.angolo)).toEqual([180]);
    expect(scene.flessibile?.irrigiditori.map((r) => r.lato)).toEqual(["bottom"]);
    expect(buildScene(scena())!.flessibile).toBeNull();
  });

  it("the viewer frames the board on the middle of its outline, tail included, and a plain rectangle on its origin as before", () => {
    // the scene goes from y = -30 to 10: its middle is 10 mm below the origin
    expect(centroDelDisegno(buildScene(scena())!.board)).toEqual({ x: 0, y: -10 });
    expect(centroDelDisegno({ width: 20, height: 20, centerX: 0, centerY: 0, layers: 2, thickness: 1.6 })).toEqual({ x: 0, y: 0 });
  });
});

describe("the thresholds, fields of design-rules.json with PCB Basic's values by default", () => {
  it("0,5 mm from a plated hole to the flexible part, 0,25 from copper to the cut, and the bend radius by layers", () => {
    expect(FORO_FLESSIBILE_MM).toBe(0.5);
    expect(BORDO_FLESSIBILE_MM).toBe(0.25);
    expect(distanzaForoFlessibile(DEFAULT_DESIGN_RULES)).toBe(0.5);
    expect(bordoDelFlessibile(DEFAULT_DESIGN_RULES)).toBe(0.25);
    // the stricter of "10 times the thickness" and the table 6 / 12 / 24
    expect([1, 2, 3, 4].map((n) => raggioDiPiegaPerSpessore(DEFAULT_DESIGN_RULES, n))).toEqual([10, 12, 24, 24]);
    expect(raggioDiPiegaPerSpessore({ ...DEFAULT_DESIGN_RULES, minBendRadiusPerThickness: 6 }, 2)).toBe(6);
    expect(distanzaForoFlessibile({ ...DEFAULT_DESIGN_RULES, minPlatedHoleToFlexMm: 0.8 })).toBe(0.8);
    expect(bordoDelFlessibile({ ...DEFAULT_DESIGN_RULES, minFlexEdgeClearanceMm: 0 })).toBe(0);
  });

  it("a written design-rules.json may carry them, within their limits", () => {
    const ok = validaFileDelleRegole(JSON.stringify({ preset: "custom", rules: { minPlatedHoleToFlexMm: 0.8, minFlexEdgeClearanceMm: 0.5, minBendRadiusPerThickness: 6 } }));
    expect("regole" in ok && ok.regole.rules).toMatchObject({ minPlatedHoleToFlexMm: 0.8, minFlexEdgeClearanceMm: 0.5, minBendRadiusPerThickness: 6 });
    const no = validaFileDelleRegole(JSON.stringify({ preset: "custom", rules: { minPlatedHoleToFlexMm: 9, minBendRadiusPerThickness: 0.5 } }));
    expect("errori" in no && no.errori.join(" ")).toMatch(/minPlatedHoleToFlexMm: 9 fuori dai limiti 0\.\.5.*minBendRadiusPerThickness: 0\.5 fuori dai limiti 1\.\.100/);
  });
});

describe("the checks of the flexible zones (drc.ts, check 10)", () => {
  it("the scene as it is has nothing to say, and a board with no zone is not asked", () => {
    expect(drc(conFile(scena()))).toEqual([]);
    // the same copper on a rigid board: none of these rules exists
    const rame = [...via("v1", 0, -20), ...pista("t1", "top", [{ x: 0, y: -12 }, { x: 0, y: -28 }])];
    expect(drc(scena(rame))).toEqual([]);
    expect(drc(conFile(scena(rame))).length).toBeGreaterThan(0);
  });

  describe("flex_plated_hole", () => {
    it("a via in a flexible zone is an error, with its dot", () => {
      const [v] = drc(conFile(scena(via("v1", 2, -20))));
      expect(v.rule).toBe("flex_plated_hole");
      expect(v.message).toBe("via v1 in (2.000, -20.000): e' nella zona flessibile «coda», dove non si fanno fori metallizzati");
      expect(v.points).toEqual([{ x: 2, y: -20 }]);
    });

    it("the copper of a via is measured from the line where the rigid part ends: 0,5 mm by default", () => {
      // ring of 0,5: centre 0,4 above the line, its copper 0,15 from it
      const [v] = drc(conFile(scena(via("v1", 0, -9.6))));
      expect(v.message).toBe("via v1 in (0.000, -9.600): rame a 0.150mm dal confine fra la parte rigida e la zona flessibile «coda» < min 0.5mm");
      // 0,5 exactly, and beyond: fine
      expect(drc(conFile(scena(via("v1", 0, -9.25))))).toEqual([]);
      expect(drc(conFile(scena(via("v1", 0, -9))))).toEqual([]);
      // beside the tail the edge of the board is the edge of the board, not the flexible part
      expect(drc(conFile(scena(via("v1", 8, -9.6))))).toEqual([]);
      // the corner where the tail leaves: 0,3 from the end of the line
      expect(drc(conFile(scena(via("v1", 6.4, -9.6)))).map((x) => x.rule)).toEqual(["flex_plated_hole"]);
    });

    it("the threshold is the project's", () => {
      const regole = { ...DEFAULT_DESIGN_RULES, minPlatedHoleToFlexMm: 0.8 };
      expect(drc(conFile(scena(via("v1", 0, -9))), regole)[0].message).toContain("rame a 0.750mm dal confine");
      expect(drc(conFile(scena(via("v1", 0, -9.6))), { ...DEFAULT_DESIGN_RULES, minPlatedHoleToFlexMm: 0.1 })).toEqual([]);
    });

    it("the plated holes of a connector 3,5 mm from the edge the tail leaves are fine, measured on their copper", () => {
      // a row of three holes, ring 1,8 and drill 1,0, their centres 3,5 mm from the edge: the copper is 2,6 mm from the line
      const connettore = [...parte("J1", 0, -6.5), ...foro("J1", "1", -2.54, -6.5), ...foro("J1", "2", 0, -6.5), ...foro("J1", "3", 2.54, -6.5)];
      expect(drc(conFile(scena(connettore)))).toEqual([]);
      // and with the copper 0,4 from it the hole is named as a person knows it
      const vicino = [...parte("J1", 0, -8.7), ...foro("J1", "2", 0, -8.7)];
      expect(messaggi(drc(conFile(scena(vicino))))).toBe("foro metallizzato J1.2 in (0.000, -8.700): rame a 0.400mm dal confine fra la parte rigida e la zona flessibile «coda» < min 0.5mm");
      // an oval ring is measured as it is: 2,4 x 1,2 lying down, its copper 0,6 above the centre
      const ovale: El[] = [{ type: "pcb_plated_hole", pcb_plated_hole_id: "ph_o", shape: "pill", x: 0, y: -9, outer_width: 2.4, outer_height: 1.2, hole_width: 1.6, hole_height: 0.6, layers: ["top", "bottom"] }];
      expect(drc(conFile(scena(ovale)))[0].message).toContain("rame a 0.400mm dal confine");
      // the same ring standing up reaches 1,2 below its centre: from y = -8,6 its copper is 0,2 from the line
      const inPiedi: El[] = [{ ...ovale[0], outer_width: 1.2, outer_height: 2.4, hole_width: 0.6, hole_height: 1.6, y: -8.6 }];
      expect(drc(conFile(scena(inPiedi)))[0].message).toContain("rame a 0.200mm dal confine");
      // and from y = -9,2 it is over the line, in the zone
      expect(drc(conFile(scena([{ ...inPiedi[0], y: -9.2 }])))[0].message).toContain("e' nella zona flessibile «coda»");
    });

    it("a bend is the stretch of tail it curves, not its line: a hole that near that stretch is said", () => {
      // a fold that starts in the rigid part: its line 0,5 mm below the edge, 1,65 mm of curve on each side
      const sopra = { ...FLEX, pieghe: [{ ...PIEGA, da: { x: -6, y: -10.5 }, a: { x: 6, y: -10.5 } }] };
      // the curve reaches y = -8,851. A via with its copper down to y = -8,45: 1,55 from the line of the edge, 0,401 from the curve
      const v = diRegola(drc(conFile(scena(via("v1", 0, -8.2)), sopra)), "flex_plated_hole");
      expect(v).toHaveLength(1);
      expect(v[0].message).toBe("via v1 in (0.000, -8.200): rame a 0.401mm dal tratto di coda che la piega «ripiega» curva (3.299mm attorno alla linea) < min 0.5mm");
      // further up it is clear of both
      expect(diRegola(drc(conFile(scena(via("v1", 0, -8)), sopra)), "flex_plated_hole")).toEqual([]);
    });
  });

  describe("flex_copper_layer: in a zone only the layers it declares exist", () => {
    it("a pad and a trace of another layer in the zone are errors, on their layer", () => {
      const rame = [...parte("TP1", 0, -20), ...piazzola("TP1", "1", 0, -20, "top"), ...pista("t1", "bottom", [{ x: -2, y: -8 }, { x: -2, y: -18 }])];
      const v = diRegola(drc(conFile(scena(rame))), "flex_copper_layer");
      expect(v.map((x) => x.message)).toEqual([
        "TP1.1: piazzola su top nella zona flessibile «coda», che ha rame solo su inner1",
        "t1: pista su bottom nella zona flessibile «coda», che ha rame solo su inner1",
      ]);
      expect(v[0].points).toEqual([{ x: 0, y: -20, layer: "top" }]);
      expect(v[1].points?.[0].layer).toBe("bottom");
    });

    it("a trace of a declared layer goes from the rigid part into the tail, and one that stays in the rigid part is not asked", () => {
      expect(drc(conFile(scena(pista("t1", "inner1", [{ x: 0, y: -5 }, { x: 0, y: -25 }]))))).toEqual([]);
      expect(drc(conFile(scena(pista("t1", "top", [{ x: -9, y: -9.5 }, { x: 9, y: -9.5 }]))))).toEqual([]);
      // a trace of another layer that only dips its edge over the line is in the zone
      expect(drc(conFile(scena(pista("t1", "top", [{ x: -3, y: -9.95 }, { x: 3, y: -9.95 }])))).map((x) => x.rule)).toEqual(["flex_copper_layer"]);
    });

    it("a pour of another layer with copper in the zone is an error; cut back along the zone it is not", () => {
      // the whole piece poured on the top, as tscircuit pours a <copperpour> with no outline
      const intera = colata("p_top", "top", CONTORNO);
      const [v] = drc(conFile(scena(intera)));
      expect(v.rule).toBe("flex_copper_layer");
      expect(v.message).toContain("colata GND su top: ha rame nella zona flessibile «coda», che ha rame solo su inner1");
      expect(v.points?.[0].layer).toBe("top");
      // the same plane cut back to the rigid part, 0,3 from the line: nothing
      expect(drc(conFile(scena(colata("p_top", "top", rettangolo(-9.7, -9.7, 9.7, 9.7)))))).toEqual([]);
      // a plane that covers the whole zone and has no vertex in it (a strip across the tail)
      expect(drc(conFile(scena(colata("p_top", "top", rettangolo(-9, -35, 9, 9))))).map((x) => x.rule)).toEqual(["flex_copper_layer"]);
      // a declared layer may be poured over the tail, 0,3 from its cut
      expect(drc(conFile(scena(colata("p_in1", "inner1", rettangolo(-5.7, -29.7, 5.7, 9.7)))))).toEqual([]);
    });
  });

  describe("flex_copper_window: a window of the zone has no copper on any layer", () => {
    const FINESTRA = { pila: PILA, zone: [zona({ finestre: [{ nome: "antenna", punti: rettangolo(-5, -28, -1, -22) }] })] };

    it("a trace and a pad in the window are errors", () => {
      const rame = [...pista("t1", "inner1", [{ x: -3, y: -12 }, { x: -3, y: -25 }])];
      const [v] = drc(conFile(scena(rame), FINESTRA));
      expect(v.rule).toBe("flex_copper_window");
      expect(v.message).toBe("t1: pista nella finestra senza rame «antenna» della zona flessibile «coda»");
      // beside the window: fine
      expect(drc(conFile(scena(pista("t1", "inner1", [{ x: 2, y: -12 }, { x: 2, y: -25 }])), FINESTRA))).toEqual([]);
      // a pad of a layer the zone has, in the window (and, being a part on the tail, an error of its own too)
      const sulTop = { pila: PILA, zone: [zona({ strati: ["top"], finestre: [{ nome: "antenna", punti: rettangolo(-5, -28, -1, -22) }] })] };
      const pad = [...parte("TP1", -3, -25), ...piazzola("TP1", "1", -3, -25, "top")];
      const delPad = drc(conFile(scena(pad), sulTop));
      expect(delPad.map((x) => x.rule).sort()).toEqual(["flex_component", "flex_copper_window"]);
      expect(diRegola(delPad, "flex_copper_window")[0].message).toBe("TP1.1: piazzola nella finestra senza rame «antenna» della zona flessibile «coda»");
    });

    it("a pour over the window is an error; with the window cut out of it, it is not", () => {
      const sopra = colata("p_in1", "inner1", rettangolo(-5.7, -29.7, 5.7, 9.7));
      expect(drc(conFile(scena(sopra), FINESTRA)).map((x) => x.rule)).toEqual(["flex_copper_window"]);
      const aperta = colata("p_in1", "inner1", rettangolo(-5.7, -29.7, 5.7, 9.7), [rettangolo(-5, -28, -1, -22)]);
      expect(drc(conFile(scena(aperta), FINESTRA))).toEqual([]);
    });
  });

  describe("flex_component: no part on the flexible part, unless over a stiffener", () => {
    const DUE_FACCE = { pila: { ...PILA, spessoreMm: 0.2 }, zone: [zona({ strati: ["top", "bottom"] })] };
    const pezzo = [...parte("R1", 0, -25), ...piazzola("R1", "1", -0.5, -25), ...piazzola("R1", "2", 0.5, -25, "top", "k2")];

    it("a part with its pads in a zone is an error, at its centre, on its face", () => {
      const [v] = drc(conFile(scena(pezzo), DUE_FACCE));
      expect(v.rule).toBe("flex_component");
      expect(v.message).toBe("R1: 2 piazzole nella zona flessibile «coda» senza irrigiditore: sul flessibile un pezzo si monta solo sopra un irrigiditore");
      expect(v.points).toEqual([{ x: 0, y: -25, layer: "top" }]);
    });

    it("over a stiffener of the other face it is allowed; one on its own face, or one that leaves a pad out, does not count", () => {
      const sotto = (lato: string, x2 = 3) => ({ ...DUE_FACCE, irrigiditori: [{ nome: "rinforzo", lato, materiale: "fr4", spessoreMm: 0.2, punti: rettangolo(-3, -27, x2, -23) }] });
      expect(drc(conFile(scena(pezzo), sotto("bottom")))).toEqual([]);
      expect(drc(conFile(scena(pezzo), sotto("top")))[0].message).toContain("R1: 2 piazzole nella zona flessibile «coda» fuori da un irrigiditore della faccia opposta");
      expect(drc(conFile(scena(pezzo), sotto("bottom", 0.5)))[0].message).toContain("R1: una piazzola nella zona flessibile «coda» fuori da un irrigiditore");
    });

    it("a part of the rigid part is not asked", () => {
      const sopra = [...parte("R2", 0, 0), ...piazzola("R2", "1", -0.5, 0), ...piazzola("R2", "2", 0.5, 0, "top", "k2")];
      expect(drc(conFile(scena(sopra), DUE_FACCE))).toEqual([]);
    });
  });

  describe("flex_edge_clearance: copper and the cut of the tail", () => {
    it("a trace nearer than 0,25 mm to the cut edge of the zone is an error; the threshold is the project's", () => {
      // 0,2 wide, its axis 0,2 from the edge: 0,1 of laminate
      const stretta = pista("t1", "inner1", [{ x: -5.8, y: -12 }, { x: -5.8, y: -28 }]);
      const [v] = drc(conFile(scena(stretta)));
      expect(v.rule).toBe("flex_edge_clearance");
      expect(v.message).toBe("t1: pista a 0.100mm dal taglio della zona flessibile «coda» < min 0.25mm");
      expect(v.points?.[0].layer).toBe("inner1");
      const larga = pista("t1", "inner1", [{ x: -5.6, y: -12 }, { x: -5.6, y: -28 }]);
      expect(drc(conFile(scena(larga)))).toEqual([]);
      expect(drc(conFile(scena(larga)), { ...DEFAULT_DESIGN_RULES, minFlexEdgeClearanceMm: 0.5 })[0].message).toContain("a 0.300mm dal taglio");
    });

    it("a pad nearer than that to the cut is an error too, on its face", () => {
      const sulTop = { pila: PILA, zone: [zona({ strati: ["top"] })], irrigiditori: [{ lato: "bottom", materiale: "fr4", spessoreMm: 0.2, punti: rettangolo(-6, -28, -3, -22) }] };
      // 0,6 wide, its centre 0,45 from the edge: 0,15 of laminate; over its stiffener, so the part itself is allowed
      const pad = [...parte("TP1", -5.55, -25), ...piazzola("TP1", "1", -5.55, -25, "top")];
      const v = drc(conFile(scena(pad), sulTop));
      expect(v.map((x) => x.rule)).toEqual(["flex_edge_clearance"]);
      expect(v[0].message).toBe("TP1.1: piazzola a 0.150mm dal taglio della zona flessibile «coda» < min 0.25mm");
      expect(v[0].points).toEqual([{ x: -5.55, y: -25, layer: "top" }]);
    });

    it("the line where the rigid part ends is not a cut: a trace crosses it", () => {
      expect(drc(conFile(scena(pista("t1", "inner1", [{ x: 0, y: -9 }, { x: 0, y: -11 }]))))).toEqual([]);
    });

    it("a cutout of the zone is a cut too: copper in it or near it is an error", () => {
      const ASOLA = { pila: PILA, zone: [zona({ ritagli: [{ nome: "asola", punti: rettangolo(2, -27, 4, -24) }] })] };
      const dentro = pista("t1", "inner1", [{ x: 3, y: -20 }, { x: 3, y: -25.5 }]);
      expect(drc(conFile(scena(dentro), ASOLA))[0].message).toBe("t1: pista nel ritaglio «asola» della zona flessibile «coda» < min 0.25mm");
      const accanto = pista("t1", "inner1", [{ x: 1.8, y: -20 }, { x: 1.8, y: -28 }]);
      expect(drc(conFile(scena(accanto), ASOLA))[0].message).toBe("t1: pista a 0.100mm dal taglio della zona flessibile «coda» < min 0.25mm");
      // a pour that was not cut back around it, and one that was
      const sopra = colata("p_in1", "inner1", rettangolo(-5.7, -29.7, 5.7, 9.7));
      expect(drc(conFile(scena(sopra), ASOLA))[0].message).toContain("colata GND su inner1: ha rame nel ritaglio «asola»");
      const aperta = colata("p_in1", "inner1", rettangolo(-5.7, -29.7, 5.7, 9.7), [rettangolo(1.7, -27.3, 4.3, -23.7)]);
      expect(drc(conFile(scena(aperta), ASOLA))).toEqual([]);
      const stretta = colata("p_in1", "inner1", rettangolo(-5.7, -29.7, 5.7, 9.7), [rettangolo(1.9, -27.1, 4.1, -23.9)]);
      expect(drc(conFile(scena(stretta), ASOLA))[0].message).toContain("colata GND su inner1: rame a 0.100mm dal taglio della zona flessibile «coda» < min 0.25mm");
    });

    it("a pour of a declared layer that reaches the cut of the tail is an error", () => {
      const alBordo = colata("p_in1", "inner1", rettangolo(-5.9, -29.9, 5.9, 9.7));
      const [v] = drc(conFile(scena(alBordo)));
      expect(v.rule).toBe("flex_edge_clearance");
      expect(v.message).toContain("colata GND su inner1: rame a 0.100mm dal taglio della zona flessibile «coda» < min 0.25mm");
    });
  });

  describe("flex_bend_radius and flex_bend_area", () => {
    const conPiega = (piega: Record<string, unknown>, altro: Record<string, unknown> = {}) => ({ ...FLEX, ...altro, pieghe: [{ ...PIEGA, ...piega }] });

    it("one layer 0,1 mm thick: 1,0 mm of radius is ten times the thickness and passes, 0,9 does not", () => {
      expect(drc(conFile(scena(), conPiega({ raggioMm: 1 })))).toEqual([]);
      const [v] = drc(conFile(scena(), conPiega({ raggioMm: 0.9 })));
      expect(v.rule).toBe("flex_bend_radius");
      expect(v.message).toBe("piega «ripiega»: raggio interno 0.9mm < min 1mm, 10 volte lo spessore della parte flessibile (0.1mm, uno strato di rame nella zona «coda»)");
      expect(v.points).toEqual([{ x: 0, y: -14 }]);
    });

    it("two layers ask twelve times, and the project may ask its own multiple", () => {
      const due = { pila: { ...PILA, spessoreMm: 0.2 }, zone: [zona({ strati: ["inner1", "inner2"] })] };
      // 90 degrees at 2 mm on 0,2: 3,3 mm of tail, inside the zone
      const piega = { raggioMm: 2, angolo: 90, da: { x: -6, y: -16 }, a: { x: 6, y: -16 } };
      expect(drc(conFile(scena(), conPiega(piega, due)))[0].message).toContain("raggio interno 2mm < min 2.4mm, 12 volte lo spessore della parte flessibile (0.2mm, 2 strati di rame");
      expect(drc(conFile(scena(), conPiega({ ...piega, raggioMm: 2.4 }, due)))).toEqual([]);
      expect(drc(conFile(scena(), conPiega(piega, due)), { ...DEFAULT_DESIGN_RULES, minBendRadiusPerThickness: 10 })).toEqual([]);
      expect(drc(conFile(scena(), conPiega({ raggioMm: 0.7 })), { ...DEFAULT_DESIGN_RULES, minBendRadiusPerThickness: 6 })).toEqual([]);
    });

    it("a fold whose curve would start in the rigid part is an error: the line needs half the arc of tail before it", () => {
      // 180 degrees at 1 mm take 1,65 mm on each side: a line 1 mm below the edge starts 0,65 mm inside the rigid part
      const [v] = drc(conFile(scena(), conPiega({ da: { x: -6, y: -11 }, a: { x: 6, y: -11 } })));
      expect(v.rule).toBe("flex_bend_area");
      expect(v.message).toBe(
        "piega «ripiega»: a 180° con raggio 1mm curva 3.299mm di coda, 1.649 per parte attorno alla linea, e quel tratto esce dalla zona flessibile «coda»: " +
          "la linea va ad almeno 1.649mm dalla parte rigida e dalla fine della coda",
      );
      // 1,7 mm below the edge there is room
      expect(drc(conFile(scena(), conPiega({ da: { x: -6, y: -11.7 }, a: { x: 6, y: -11.7 } })))).toEqual([]);
      // and past the end of the tail it is said too
      expect(drc(conFile(scena(), conPiega({ da: { x: -6, y: -29 }, a: { x: 6, y: -29 } }))).map((x) => x.rule)).toEqual(["flex_bend_area"]);
    });
  });

  it("flex_stiffener_bend: a stiffener over the stretch a bend curves", () => {
    const conIrrigiditore = (y1: number, y2: number) => ({ ...FLEX, irrigiditori: [{ nome: "rinforzo", lato: "bottom", materiale: "poliimmide", spessoreMm: 0.2, punti: rettangolo(-5, y1, 5, y2) }] });
    // from y = -20 up to -15: 0,65 mm into the curve, though clear of the line
    const [v] = drc(conFile(scena(), conIrrigiditore(-20, -15)));
    expect(v.rule).toBe("flex_stiffener_bend");
    expect(v.message).toBe("l'irrigiditore «rinforzo» (bottom) e' sopra il tratto di coda che la piega «ripiega» curva: li' la scheda non piega");
    expect(drc(conFile(scena(), conIrrigiditore(-28, -16)))).toEqual([]);
  });

  it("flex_bend_crossing, a warning: a trace across the bend line off the perpendicular", () => {
    const dritta = pista("t1", "inner1", [{ x: 0, y: -11 }, { x: 0, y: -17 }]);
    expect(drc(conFile(scena(dritta)))).toEqual([]);
    // 5 degrees off: within the ten that are let pass
    const quasi = pista("t1", "inner1", [{ x: 0, y: -11 }, { x: 6 * Math.tan((5 * Math.PI) / 180), y: -17 }]);
    expect(drc(conFile(scena(quasi)))).toEqual([]);
    const storta = pista("t1", "inner1", [{ x: -3, y: -11 }, { x: 3, y: -17 }]);
    const [v] = drc(conFile(scena(storta)));
    expect(v.rule).toBe("flex_bend_crossing");
    expect(v.message).toBe("avviso: t1 attraversa la linea di piega «ripiega» a 45° invece che a 90° (inner1): sulla piega le piste vanno perpendicolari");
    expect(v.points).toEqual([{ x: expect.closeTo(0, 9), y: expect.closeTo(-14, 9), layer: "inner1" }]);
    // a trace that does not reach the line is not asked
    expect(drc(conFile(scena(pista("t1", "inner1", [{ x: -3, y: -16 }, { x: 3, y: -22 }]))))).toEqual([]);
  });
});

describe("the pours are cut back from the zones (the obstacles handed to the solver)", () => {
  const COMPLETO = { pila: PILA, zone: [zona({ finestre: [{ nome: "antenna", punti: rettangolo(-5, -28, -1, -22) }], ritagli: [{ nome: "asola", punti: rettangolo(2, -27, 4, -24) }] })] };

  it("on a layer the zone does not declare the whole zone is a hole, with the board's edge clearance around it", () => {
    const ostacoli = ostacoliDelFlessibile(scena(), file(COMPLETO), 0.3, 0.25)!;
    for (const strato of ["top", "inner2", "bottom"]) {
      const [o, ...lati] = ostacoli(strato);
      // the zone as it is drawn, subtracted as it is
      expect(o).toMatchObject({ shape: "polygon", layer: strato, connectivityKey: "unconnected:flessibile_0" });
      expect(o.points).toHaveLength(4);
      expect(o.margineMm).toBeUndefined();
      // and a capsule of 0,3 along each of its four sides, as the band along the outline of the board is drawn
      expect(lati.map((l) => l.padId)).toEqual([0, 1, 2, 3].map((k) => `flessibile_0_lato_${k}`));
      for (const l of lati) {
        const ys = (l.points as Punto[]).map((q) => q.y);
        const xs = (l.points as Punto[]).map((q) => q.x);
        // 0,3 beyond the side on every side of it, within the two micrometres of the arcs
        expect(Math.min(Math.max(...ys) - Math.min(...ys), Math.max(...xs) - Math.min(...xs))).toBeCloseTo(0.6, 2);
      }
      // the one along the line where the rigid part ends reaches y = -9,7 and no further
      expect(Math.max(...lati.flatMap((l) => (l.points as Punto[]).map((q) => q.y)))).toBeCloseTo(-9.7, 2);
    }
  });

  it("on a declared layer the copper goes into the zone and stops at its windows, exactly, and around its cutouts", () => {
    const ostacoli = ostacoliDelFlessibile(scena(), file(COMPLETO), 0.3, 0.25)!("inner1");
    expect(ostacoli.map((o) => o.padId)).toEqual(["flessibile_0_finestra_0", "flessibile_0_ritaglio_0"]);
    expect(ostacoli[0].margineMm).toBeUndefined();
    expect(ostacoli[1].margineMm).toBe(0.3);
    // a flexible edge clearance wider than the board's: a capsule along each of the three cut sides, and the cutout by that much
    const larghi = ostacoliDelFlessibile(scena(), file(COMPLETO), 0.3, 0.5)!("inner1");
    expect(larghi.filter((o) => String(o.padId).includes("_bordo_"))).toHaveLength(3);
    expect(larghi.find((o) => o.padId === "flessibile_0_ritaglio_0")?.margineMm).toBe(0.5);
  });

  it("a zone off the board cuts nothing", () => {
    expect(ostacoliDelFlessibile(scena(), file({ pila: PILA, zone: [zona({ punti: rettangolo(-8, -30, 8, -10) })] }), 0.3, 0.25)).toBeUndefined();
  });
});

describe("the Gerber of a rigid-flex board", () => {
  const COMPLETO = {
    pila: { ...PILA, materiali: [{ tipo: "coverlay", nome: "PI 12.5um + adhesive 15um", mm: 0.0275 }, { tipo: "rame", nome: "RA 18um", mm: 0.018 }] },
    zone: [zona({ strati: ["top"], finestre: [{ nome: "antenna", punti: rettangolo(-5, -28, -1, -22) }], ritagli: [{ nome: "asola", punti: rettangolo(2, -27, 4, -24) }] })],
    pieghe: [PIEGA],
    irrigiditori: [{ nome: "rinforzo", lato: "bottom", materiale: "fr4", spessoreMm: 0.2, punti: rettangolo(-5.5, -29.5, 5.5, -17), fori: [{ x: 0, y: -19, diametroMm: 1 }] }],
    coverlay: { top: [{ nome: "contatto", punti: rettangolo(-1, -20.5, 1, -19.5) }], bottom: [] },
  };
  const seri = (id: string, y: number): El => ({ type: "pcb_silkscreen_path", pcb_silkscreen_path_id: id, layer: "top", route: [{ x: -2, y }, { x: 2, y }], stroke_width: 0.15 });
  const SCENA = scena(parte("TP1", 5, -19), piazzola("TP1", "1", 5, -19, "top"), parte("R9", 0, 5), piazzola("R9", "1", 0, 5, "top"), [seri("s_rigido", 3), seri("s_coda", -25)]);
  const senzaData = (g: string) => g.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<data>");
  const converti = (cj: El[]) => convertSoupToGerberCommands(cj as never) as unknown as Record<string, unknown>;
  const strati = (comandi: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(stringifyGerberCommandLayers(comandi as never)).map(([k, v]) => [k, senzaData(String(v))]));
  /** the layers as the export writes them: the windows of the mask drawn by hand, then the flexible zones */
  const gerber = (cj: El[]) => strati(comandiConIlFlessibile(cj, (scheda) => comandiConLaMaschera(scheda, converti)));
  const regioni = (g: string) => (g.match(/G36\*/g) ?? []).length;
  const lampi = (g: string) => (g.match(/D03\*/g) ?? []).length;
  /** the tracks a layer draws: how many moves with the pen down */
  const tratti = (g: string) => (g.match(/D01\*/g) ?? []).length;

  it("a board with no zone is written as it always was: the same commands, layer by layer, and no file more", () => {
    const prima = strati(comandiConLaMaschera(SCENA, converti));
    const dopo = gerber(SCENA);
    expect(Object.keys(dopo)).toEqual(Object.keys(prima));
    for (const strato of Object.keys(prima)) expect(dopo[strato], strato).toBe(prima[strato]);
    expect(fileDelFlessibile(SCENA, {}, "p")).toEqual({});
  });

  it("the mask is open over the zones on both faces, and the silkscreen does not enter them; the copper, the paste and the drill are the board's", () => {
    const cj = conFile(SCENA, COMPLETO);
    const prima = gerber(SCENA);
    const dopo = gerber(cj);
    // the two pads keep their openings, and the zone is one region more on each face
    expect(lampi(prima.F_Mask)).toBe(2);
    expect(regioni(prima.F_Mask)).toBe(0);
    expect(lampi(dopo.F_Mask)).toBe(2);
    expect(regioni(dopo.F_Mask)).toBe(1);
    expect(regioni(prima.B_Mask)).toBe(0);
    expect(regioni(dopo.B_Mask)).toBe(1);
    expect(dopo.F_Mask).toMatch(/X-0*6000000Y-0*30000000D0[12]\*/);
    // one of the two silkscreen strokes is in the tail: it is not written
    expect(tratti(prima.F_SilkScreen)).toBe(2);
    expect(tratti(dopo.F_SilkScreen)).toBe(1);
    expect(dopo.F_SilkScreen).not.toMatch(/Y-0*25000000/);
    for (const strato of ["F_Cu", "B_Cu", "In1_Cu", "In2_Cu", "F_Paste", "B_Paste"]) expect(dopo[strato], strato).toBe(prima[strato]);
    // the outline is one, with the cutout of the tail in it
    expect(prima.Edge_Cuts).not.toMatch(/X0*2000000Y-0*27000000/);
    expect(dopo.Edge_Cuts).toMatch(/X0*2000000Y-0*27000000/);
    expect(dopo.Edge_Cuts).toContain(prima.Edge_Cuts.split("\n").find((r) => /^X-0*10000000Y-0*10000000D02\*$/.test(r))!);
    // and the checks said it: the silkscreen that is not printed
    expect(avvisiDelFlessibile(cj, file(COMPLETO)).map((a) => a.message).join(" ")).toContain("un disegno di serigrafia entra nella zona flessibile «coda»: non viene scritto nel Gerber");
  });

  it("the package gets the mechanical layer, the coverlay per face, the stiffeners per face and the text for the fab", () => {
    const cj = conFile(SCENA, COMPLETO);
    const f = fileDelFlessibile(cj, file(COMPLETO), "tm-4l-q1");
    // no stiffener on the top: no file for it
    expect(Object.keys(f).sort()).toEqual([FILE_COVERLAY.bottom, FILE_IRRIGIDITORI.bottom, FILE_COVERLAY.top, FILE_MECCANICO, FILE_PILA].sort());
    expect(FILE_IRRIGIDITORI.top in f).toBe(false);
    for (const [nome, testo] of Object.entries(f)) {
      if (!nome.endsWith(".gbr")) continue;
      expect(testo, nome).toMatch(/^G04 PCB Studio, rigid-flex: /);
      expect(testo, nome).toContain("%FSLAX46Y46*%\n%MOMM*%");
      expect(testo.trimEnd().endsWith("M02*"), nome).toBe(true);
      // every aperture used is declared
      for (const d of testo.match(/^D(\d+)\*$/gm) ?? []) expect(testo, `${nome} ${d}`).toContain(`%ADD${d.slice(1, -1)}C,`);
    }
    // the mechanical layer: the zone as a closed line, the window dotted, the bend line dashed (12 mm in dashes of 2 and gaps of 1: four)
    const m = f[FILE_MECCANICO];
    expect(m).toContain("%ADD10C,0.100000*%");
    expect(m).toContain("%ADD11C,0.200000*%");
    expect(m).toContain("X-6000000Y-10000000D02*\nX6000000Y-10000000D01*\nX6000000Y-30000000D01*\nX-6000000Y-30000000D01*\nX-6000000Y-10000000D01*");
    expect(m).toContain("X-6000000Y-14000000D02*\nX-4000000Y-14000000D01*");
    expect((m.split("D11*")[1].match(/D02\*/g) ?? []).length).toBe(4);
    expect(regioni(m)).toBe(0);
    // the coverlay of the top: the zone dark; clear, the cutout, the opening of the file and the opening of the pad TP1 (0,6 + 2 x 0,05)
    const top = f[FILE_COVERLAY.top];
    expect(top).toContain("POSITIVE: dark = coverlay");
    expect(regioni(top)).toBe(4);
    expect(top.indexOf("%LPC*%")).toBeGreaterThan(top.indexOf("G37*"));
    expect(top).toContain("X4650000Y-19350000D02*");
    // the bottom has no pad and no opening of its own: the zone and the cutout
    expect(regioni(f[FILE_COVERLAY.bottom])).toBe(2);
    // the stiffener of the bottom: one region and its hole, a clear flash of its diameter
    const irr = f[FILE_IRRIGIDITORI.bottom];
    expect(regioni(irr)).toBe(1);
    expect(irr).toContain("%ADD10C,1.000000*%");
    expect(irr).toMatch(/%LPC\*%\nD10\*\nX0Y-19000000D03\*/);
  });

  it("the text says the two stacks, the zones, the bends and the stiffeners, in English", () => {
    const regole = JSON.stringify({
      preset: "jlcpcb_standard",
      stackup: { copperMm: [0.035, 0.0175, 0.0175, 0.035], dielectrics: [{ mm: 0.2, kind: "prepreg", name: "7628" }, { mm: 1.065, kind: "core" }, { mm: 0.2, kind: "prepreg", name: "7628" }] },
    });
    const cj = conFile(SCENA, COMPLETO);
    const t = fileDelFlessibile(cj, { ...file(COMPLETO), "design-rules.json": regole }, "tm-4l-q1")[FILE_PILA];
    for (const riga of [
      "RIGID-FLEX BOARD: STACK-UP, FLEXIBLE ZONES AND BEND NOTES",
      "Project: tm-4l-q1",
      "Edge_Cuts.gbr        ONE outline for the whole piece",
      "F_Coverlay.gbr       Coverlay on the top side of the flexible zones. POSITIVE: dark = coverlay, clear = opening.",
      "B_Stiffener.gbr      Stiffeners glued on the bottom side.",
      "The flexible zones are drawn OPEN: no liquid solder mask on the flexible part, coverlay instead.",
      "Copper layers: 4 (Top, Inner 1, Inner 2, Bottom)",
      "Finished thickness: 1.6 mm",
      "Top        copper      0.035 mm",
      "prepreg     0.2 mm  7628",
      "core        1.065 mm",
      "Thickness: 0.1 mm (coverlay included, stiffeners not included)",
      "Coverlay: yellow",
      " 1. coverlay   0.0275 mm  PI 12.5um + adhesive 15um",
      " 2. copper     0.018 mm  RA 18um",
      'Zone 1 "coda": copper layers of the board that continue in the zone: Top (1). Every other layer ends at the rigid-flex boundary.',
      "Extent: x -6 to 6, y -30 to -10; area 240 mm2",
      "Rigid-flex boundary: from (-6, -10) to (6, -10)",
      'Copper-free window "antenna" (no copper on any layer, base material and coverlay stay): x -5 to -1, y -28 to -22',
      'Cutout "asola" (cut through the flexible part, on Edge_Cuts.gbr): x 2 to 4, y -27 to -24',
      "Coverlay openings, top side: 1 drawn in the project, 1 for the SMD pads of the zone",
      '"ripiega" (zone "coda"): from (-6, -14) to (6, -14); inner bend radius 1 mm; angle 180 degrees (folded back over the board); the part beyond the line folds towards the TOP side (top side inside the bend). Bend area: 3.2987 mm of tail, centred on the line',
      '"rinforzo": bottom side, FR4, 0.2 mm thick; extent x -5.5 to 5.5, y -29.5 to -17; area 137.5 mm2',
      "Holes through the stiffener: d 1 at (0, -19)",
    ]) {
      expect(t, riga).toContain(riga);
    }
    expect(t).not.toContain("F_Stiffener.gbr");
    // a project that declares no stackup says so, and a name of a project that is not one is not written
    const senza = fileDelFlessibile(cj, file(COMPLETO), "../../etc/passwd\nX")[FILE_PILA];
    expect(senza).toContain("Stack-up: not declared in the project");
    expect(senza).toContain("Project: -\n");
  });
});

describe("the copper of a zone as a grid (retino)", () => {
  /** lines 0,3 wide every 0,8, straight: squares of 0,5 between them */
  const RETINO = { larghezzaMm: 0.3, passoMm: 0.8, angolo: 0, dove: "tutta" };
  const conRetinoNelFile = (retino: Record<string, unknown>, altro: Record<string, unknown> = {}) => ({ ...FLEX, ...altro, zone: [zona({ retino })] });
  /** the ground of inner1 over the rigid part and down the tail, 0,3 from its cut, as the compile pours it */
  const PIANO = colata("p_in1", "inner1", rettangolo(-5.7, -29.7, 5.7, 9.7));
  /** the board as the compile leaves it: the file on it, then the grid laid on its pours (minimum trace width 0,15) */
  const compilata = (els: El[], corpo: unknown, minima = 0.15) => conRetino(conFile(els, corpo), minima);
  type AnelloDiProva = { vertices: Punto[] } & Record<string, unknown>;
  const buchi = (cj: El[], id = "p_in1") => ((cj.find((e) => e.pcb_copper_pour_id === id)!.brep_shape as { inner_rings: AnelloDiProva[] }).inner_rings);
  const quadrati = (cj: El[], id = "p_in1") => buchi(cj, id).filter((a) => a[ANELLO_DEL_RETINO] === true).map((a) => a.vertices);
  const areaConSegno = (v: Punto[]) => v.reduce((t, p, i) => t + p.x * v[(i + 1) % v.length].y - v[(i + 1) % v.length].x * p.y, 0) / 2;
  const centro = (v: Punto[]) => ({ x: v.reduce((t, p) => t + p.x, 0) / v.length, y: v.reduce((t, p) => t + p.y, 0) / v.length });

  describe("in the file", () => {
    const valida = (retino: unknown, regole?: { larghezzaMinimaMm: number; distanzaMinimaMm: number }, z: Record<string, unknown> = {}) =>
      validaFileDelFlessibile(JSON.stringify({ ...FLEX, zone: [zona({ retino, ...z })] }), z.punti ? undefined : SCHEDA, regole);

    it("a grid is read with its margin, a millimetre unless written", () => {
      const esito = valida({ ...RETINO, dove: "piega" });
      if ("errori" in esito) throw new Error(esito.errori.join("; "));
      expect(esito.flex.zone[0].retino).toEqual({ larghezzaMm: 0.3, passoMm: 0.8, angolo: 0, dove: "piega", margineMm: 1 });
      const suo = valida({ ...RETINO, margineMm: 2.5 });
      expect("flex" in suo && suo.flex.zone[0].retino?.margineMm).toBe(2.5);
    });

    it("a wrong one refuses the file: its lines under the project's minimum trace width, no square between them, a word that is not one", () => {
      const REGOLE = { larghezzaMinimaMm: 0.15, distanzaMinimaMm: 0.127 };
      const casi: Array<[unknown, RegExp, typeof REGOLE | undefined]> = [
        ["a griglia", /zone\[0\]\.retino: serve un oggetto/, undefined],
        [{ ...RETINO, colore: "oro" }, /zone\[0\]\.retino: un campo sconosciuto \(ammessi larghezzaMm, passoMm, angolo, dove, margineMm\)/, undefined],
        // 0,1 is a line a fab makes, and under the 0,15 this project draws its narrowest copper at
        [{ ...RETINO, larghezzaMm: 0.1 }, /zone\[0\]\.retino\.larghezzaMm: .* da 0\.15 a 5 \(0\.15 e' la pista minima del progetto, minTraceWidthMm\)/, REGOLE],
        [{ ...RETINO, larghezzaMm: 0.01 }, /zone\[0\]\.retino\.larghezzaMm: .* da 0\.05 a 5$/, undefined],
        [{ ...RETINO, larghezzaMm: "0.3" }, /zone\[0\]\.retino\.larghezzaMm/, undefined],
        [{ ...RETINO, passoMm: 0.3 }, /zone\[0\]\.retino\.passoMm: .* almeno 0\.1 piu' della larghezza delle linee/, undefined],
        // 0,1 of square is under the 0,127 the project keeps between two pieces of copper
        [{ ...RETINO, passoMm: 0.4 }, /zone\[0\]\.retino\.passoMm: .* almeno 0\.127 piu' della larghezza/, REGOLE],
        [{ ...RETINO, passoMm: 50 }, /zone\[0\]\.retino\.passoMm: .* fino a 20/, undefined],
        [{ ...RETINO, angolo: 120 }, /zone\[0\]\.retino\.angolo: .* da 0 a 90/, undefined],
        [{ ...RETINO, dove: "bordo" }, /zone\[0\]\.retino\.dove: deve essere "piega"/, undefined],
        [{ ...RETINO, margineMm: -1 }, /zone\[0\]\.retino\.margineMm/, undefined],
      ];
      for (const [retino, atteso, regole] of casi) {
        const esito = valida(retino, regole);
        expect("errori" in esito && esito.errori.join("; "), String(atteso)).toMatch(atteso);
      }
      // equal to the minimum is allowed
      expect("flex" in valida({ ...RETINO, larghezzaMm: 0.15 }, REGOLE)).toBe(true);
      // a grid finer than a zone can hold: 400 x 400 mm at a step of 0,8 would be 250 000 squares
      const grande = valida(RETINO, undefined, { punti: rettangolo(-200, -200, 200, 200) });
      expect("errori" in grande && grande.errori.join("; ")).toMatch(new RegExp(`zone\\[0\\]\\.retino\\.passoMm: troppo fitto per questa zona \\(piu' di ${MAX_APERTURE_RETINO} quadrati\\)`));
    });

    it("is put on the zone of the board, for the compile to lay", () => {
      const [z] = conFile(scena(), conRetinoNelFile({ ...RETINO, dove: "piega" })).filter((e) => e.type === "pcb_flex_zone");
      expect(z.hatch).toEqual({ width_mm: 0.3, pitch_mm: 0.8, angle_deg: 0, where: "piega", margin_mm: 1 });
      expect(conFile(scena()).find((e) => e.type === "pcb_flex_zone")!.hatch).toBeUndefined();
    });
  });

  describe("on the pours", () => {
    it("a pour of a layer of the zone gets the squares between the lines as holes: whole in the zone, a line from every edge of the copper", () => {
      const cj = compilata(scena(PIANO), conRetinoNelFile(RETINO));
      const q = quadrati(cj);
      /*
       * Squares of 0,5 centred every 0,8 from 0,4. Across the tail the copper goes from -5,7 to 5,7 and a line of 0,3
       * stays along each side: centres from -4,4 to 4,4, twelve columns. Along it, from a line below where the zone
       * starts (y = -10,3) to a line above the end of the copper (-29,4): centres from -10,8 to -28,4, twenty-three rows.
       */
      expect(q).toHaveLength(12 * 23);
      for (const v of q) {
        expect(v).toHaveLength(4);
        // clockwise, as the holes of a pour are, and 0,5 x 0,5
        expect(areaConSegno(v)).toBeCloseTo(-0.25, 9);
        for (const p of v) {
          expect(Math.abs(p.x)).toBeLessThanOrEqual(5.4 + 1e-9);
          expect(p.y).toBeLessThanOrEqual(-10.3 + 1e-9);
          expect(p.y).toBeGreaterThanOrEqual(-29.4 - 1e-9);
        }
      }
      const centri = q.map(centro);
      expect(Math.min(...centri.map((c) => c.x))).toBeCloseTo(-4.4, 9);
      expect(Math.max(...centri.map((c) => c.y))).toBeCloseTo(-10.8, 9);
      expect(Math.min(...centri.map((c) => c.y))).toBeCloseTo(-28.4, 9);
      // between two squares there is a line: no two centres nearer than the step
      for (let i = 0; i < centri.length; i++) {
        for (let j = i + 1; j < centri.length; j++) expect(Math.hypot(centri[i].x - centri[j].x, centri[i].y - centri[j].y)).toBeGreaterThanOrEqual(0.8 - 1e-9);
      }
      // and the zone says how many were cut
      expect(flessibileDellaScheda(cj)!.zone[0].retino).toMatchObject({ aperture: 276 });
    });

    it("the copper stays one piece: the same pour, its outline untouched, lighter by the squares and nothing else", () => {
      const prima = conFile(scena(PIANO), conRetinoNelFile(RETINO));
      const dopo = conRetino(prima, 0.15);
      const colate = (cj: El[]) => cj.filter((e) => e.type === "pcb_copper_pour");
      expect(colate(dopo)).toHaveLength(1);
      const forma = (cj: El[]) => colate(cj)[0].brep_shape as { outer_ring: { vertices: Punto[] }; inner_rings: AnelloDiProva[] };
      expect(forma(dopo).outer_ring).toEqual(forma(prima).outer_ring);
      expect(forma(dopo).inner_rings).toHaveLength(276);
      // every other element of the board is the one it was, in its place
      expect(dopo.map((e) => e.type)).toEqual(prima.map((e) => e.type));
      // nothing of the rigid part is cut, nor of the other layers
      const altrove = [...colata("p_top", "top", rettangolo(-9.7, -9.7, 9.7, 9.7)), ...colata("p_in2", "inner2", rettangolo(-9.7, -9.7, 9.7, 9.7))];
      const cj = compilata(scena(PIANO, altrove), conRetinoNelFile(RETINO));
      expect(buchi(cj, "p_top")).toEqual([]);
      expect(buchi(cj, "p_in2")).toEqual([]);
    });

    it("on the bend only: the stretch the fold curves and the margin beyond it, solid everywhere else", () => {
      // the fold of the scene curves from y = -12,35 to -15,65; with 0,9 of margin the grid may go from -11,45 to -16,55
      const q = quadrati(compilata(scena(PIANO), conRetinoNelFile({ ...RETINO, dove: "piega", margineMm: 0.9 })));
      expect(q).toHaveLength(12 * 5);
      const ys = q.flatMap((v) => v.map((p) => p.y));
      expect(Math.max(...ys)).toBeCloseTo(-12.15, 9);
      expect(Math.min(...ys)).toBeCloseTo(-15.85, 9);
      // a zone that asks it on the bend and has no bend gets none, and the checks say why
      const senzaPiega = { pila: PILA, zone: [zona({ retino: { ...RETINO, dove: "piega" } })] };
      const cj = compilata(scena(PIANO), senzaPiega);
      expect(quadrati(cj)).toEqual([]);
      expect(avvisiDelFlessibile(cj, file(senzaPiega)).map((a) => a.message).join(" ")).toContain(
        "il retino della zona «coda» non ha tagliato nessun quadrato, il rame della zona e' pieno: e' chiesto sulla piega e la zona non ha pieghe",
      );
    });

    it("turned by 45 degrees the squares are diamonds, on the same rules", () => {
      const q = quadrati(compilata(scena(PIANO), conRetinoNelFile({ ...RETINO, angolo: 45 })));
      expect(q.length).toBeGreaterThan(200);
      for (const v of q) {
        // the corners are written to the micron: the area to five decimals
        expect(areaConSegno(v)).toBeCloseTo(-0.25, 5);
        // a diamond: its corners above, below, left and right of its middle, 0,354 away
        const c = centro(v);
        for (const p of v) expect(Math.min(Math.abs(p.x - c.x), Math.abs(p.y - c.y))).toBeLessThan(1e-6);
        for (const p of v) {
          expect(Math.abs(p.x)).toBeLessThanOrEqual(5.4 + 1e-6);
          expect(p.y).toBeGreaterThanOrEqual(-29.4 - 1e-6);
          expect(p.y).toBeLessThanOrEqual(-10.3 + 1e-6);
        }
      }
    });

    it("a square is not cut where it would leave less than a line of copper: around a hole of the pour, a window, a cutout", () => {
      // the opening of the plane around a via of another net, 0,5 of radius, right where a square would be (0,4; -20,4)
      const ottagono = Array.from({ length: 8 }, (_, i) => ({ x: 0.4 + 0.5 * Math.cos((-i * Math.PI) / 4), y: -20.4 + 0.5 * Math.sin((-i * Math.PI) / 4) }));
      const conBuco = colata("p_in1", "inner1", rettangolo(-5.7, -29.7, 5.7, 9.7), [ottagono]);
      const q = quadrati(compilata(scena(conBuco), conRetinoNelFile(RETINO)));
      // that square is not there, nor the eight around it: the four beside it would be 0,05 from the opening, the four across its corners 0,28
      expect(q).toHaveLength(276 - 9);
      for (const v of q) {
        for (const p of v) expect(Math.hypot(p.x - 0.4, p.y + 20.4)).toBeGreaterThanOrEqual(0.5 * Math.cos(Math.PI / 8) + 0.3 - 1e-6);
      }
      // the hole the pour had is still its first, unmarked
      expect(buchi(compilata(scena(conBuco), conRetinoNelFile(RETINO)))[0]).toEqual({ vertices: ottagono });
    });

    it("lines narrower than the project's minimum trace width are not laid, and the checks say so", () => {
      const corpo = conRetinoNelFile(RETINO);
      const cj = compilata(scena(PIANO), corpo, 0.4);
      expect(quadrati(cj)).toEqual([]);
      expect(flessibileDellaScheda(cj)!.zone[0].retino).toMatchObject({ aperture: 0, nonApplicato: "larghezza" });
      expect(avvisiDelFlessibile(cj, file(corpo)).map((a) => a.message).join(" ")).toContain(
        "il retino della zona «coda» ha linee da 0.3 mm, sotto la pista minima del progetto (minTraceWidthMm): non e' stato applicato",
      );
      // at 0,3 exactly it is laid
      expect(quadrati(compilata(scena(PIANO), corpo, 0.3))).toHaveLength(276);
      expect(avvisiDelFlessibile(compilata(scena(PIANO), corpo, 0.3), file(corpo))).toEqual([]);
    });

    it("laid twice it is the same grid, and it comes off whole: the recheck works on the solid planes and lays it again", () => {
      const prima = conFile(scena(PIANO), conRetinoNelFile(RETINO));
      const una = conRetino(prima, 0.15);
      expect(conRetino(una, 0.15)).toEqual(una);
      // solid again: the pour it was
      expect(senzaRetino(una).find((e) => e.type === "pcb_copper_pour")).toEqual(prima.find((e) => e.type === "pcb_copper_pour"));
      // the file loses its grid: at the next pass the pours are solid again
      const senza = conRetino(conFile(una, FLEX), 0.15);
      expect(quadrati(senza)).toEqual([]);
      // a finer grid in the file replaces the one on the board, it is not cut over it
      const fine = conRetino(conFile(una, conRetinoNelFile({ ...RETINO, passoMm: 0.6 })), 0.15);
      expect(quadrati(fine).every((v) => Math.abs(areaConSegno(v) + 0.09) < 1e-9)).toBe(true);
      expect(quadrati(fine).length).toBeGreaterThan(276);
    });

    it("a board that asks no grid is given back as it came, the same array", () => {
      const rigida = scena(PIANO);
      expect(conRetino(rigida, 0.15)).toBe(rigida);
      expect(senzaRetino(rigida)).toBe(rigida);
      const flessibile = conFile(scena(PIANO));
      expect(conRetino(flessibile, 0.15)).toBe(flessibile);
    });
  });

  describe("in the viewer, the Gerber and the text for the fab", () => {
    const cj = () => compilata(scena(PIANO), conRetinoNelFile(RETINO));

    it("the viewer draws the pour with its squares, as it draws every hole of a pour", () => {
      const [p] = buildScene(cj())!.pours;
      // one closed path for the outline and one per square
      expect((p.path.match(/M /g) ?? []).length).toBe(1 + 276);
      expect(buildScene(cj())!.flessibile!.zone[0].retino).toMatchObject({ dove: "tutta", larghezzaMm: 0.3, passoMm: 0.8 });
    });

    it("the Gerber of the layer has the grid: one clear region per square, and no other layer changes", () => {
      const converti = (els: El[]) => convertSoupToGerberCommands(els as never) as unknown as Record<string, unknown>;
      const strati = (els: El[]) => stringifyGerberCommandLayers(comandiConIlFlessibile(els, (scheda) => comandiConLaMaschera(scheda, converti)) as never) as Record<string, string>;
      const senzaData = (g: string) => g.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<data>");
      const piena = strati(conFile(scena(PIANO), conRetinoNelFile(RETINO)));
      const griglia = strati(cj());
      const regioni = (g: string) => (g.match(/G36\*/g) ?? []).length;
      expect(regioni(piena.In1_Cu)).toBe(1);
      expect(regioni(griglia.In1_Cu)).toBe(1 + 276);
      expect(griglia.In1_Cu).toContain("%LPC*%");
      // the lowest square of the first column: its corner at (-4,65; -28,65)
      expect(griglia.In1_Cu).toMatch(/X-0*4650000Y-0*28650000D0[12]\*/);
      for (const strato of Object.keys(piena)) {
        if (strato !== "In1_Cu") expect(senzaData(griglia[strato]), strato).toBe(senzaData(piena[strato]));
      }
    });

    it("the text says the copper of the zone is a grid, with its measures", () => {
      const t = fileDelFlessibile(cj(), file(conRetinoNelFile(RETINO)), "p")[FILE_PILA];
      expect(t).toContain("Copper: cross-hatched (grid), not solid, in the whole zone. Lines 0.3 mm wide, pitch 0.8 mm, at 0 degrees (276 openings). It is drawn in the copper layers as it is to be made.");
      const sullaPiega = { ...RETINO, dove: "piega" };
      expect(fileDelFlessibile(compilata(scena(PIANO), conRetinoNelFile(sullaPiega)), file(conRetinoNelFile(sullaPiega)), "p")[FILE_PILA]).toContain(
        "Copper: cross-hatched (grid), not solid, in the bend area and 1 mm beyond it on each side; solid elsewhere.",
      );
      // a zone with solid copper says nothing of it
      expect(fileDelFlessibile(conFile(scena(PIANO)), file(FLEX), "p")[FILE_PILA]).not.toContain("cross-hatched");
    });
  });
});
