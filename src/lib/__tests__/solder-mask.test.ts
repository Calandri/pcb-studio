import { describe, expect, it } from "vitest";
import { convertSoupToGerberCommands, stringifyGerberCommandLayers } from "circuit-json-to-gerber";
import { buildScene } from "@/components/board/render";
import { campiDelleRegole, DEFAULT_DESIGN_RULES, DIGA_MASCHERA_MM, validaFileDelleRegole, type DesignRules } from "@/lib/design-rules";
import { apertureAMano, runDrcChecks, type DrcViolation } from "@/lib/drc";
import {
  avvisiDellaMaschera,
  circuitoPerLaMaschera,
  comandiConLaMaschera,
  conMascheraAMano,
  leggiMaschera,
  MASCHERA_PATH,
  MAX_APERTURE_MASCHERA,
  MAX_VERTICI,
  validaFileDellaMaschera,
} from "@/lib/solder-mask";
import { provaViaNuova } from "@/lib/spinta/via-nuova";

/*
 * THE MASK WINDOWS DRAWN BY HAND (maschera.json).
 *
 * The scene: a board 20 x 20 mm with two parts on the top.
 * - U1, a row of four pins at pitch 0,5 (pads 0,3 x 1,0, margin 0,05) along
 *   y = 2: the openings of the pads are 0,4 wide and leave 0,1 mm of mask
 *   between two of them, under the 0,1016 of PCB Basic. That is the LQFP64 of
 *   sbb-dl-principale.
 * - FL1, two rows of three pins at pitch 0,4 (pads 0,2 x 0,5) at y = +-1 and a
 *   ground pad 1,0 x 0,6 in the middle: the EMIF06. Its rows get a window each,
 *   its ground pad keeps its own opening and the mask around it.
 * Every pin of U1 is on SIG (k2), the pins of FL1 on GND (k1).
 */
type El = Record<string, unknown> & { type: string };

const MARGINE = 0.05;
const BOARD: El = { type: "pcb_board", pcb_board_id: "b1", center: { x: 0, y: 0 }, width: 20, height: 20, num_layers: 2, thickness: 1.6 };

function parte(nome: string, id: string): El[] {
  return [
    { type: "source_component", source_component_id: `sc_${id}`, name: nome },
    { type: "pcb_component", pcb_component_id: id, source_component_id: `sc_${id}`, center: { x: 0, y: 0 }, layer: "top", rotation: 0, width: 1, height: 1 },
  ];
}

function piazzola(comp: string, pin: string, rete: "k1" | "k2", forma: Record<string, unknown>): El[] {
  const id = `${comp}_${pin}`;
  return [
    { type: "source_port", source_port_id: `sp_${id}`, name: pin, source_component_id: `sc_${comp}`, subcircuit_connectivity_map_key: rete },
    { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, pcb_component_id: comp, x: 0, y: 0, layers: ["top"] },
    {
      type: "pcb_smtpad",
      pcb_smtpad_id: `pad_${id}`,
      pcb_component_id: comp,
      pcb_port_id: `pp_${id}`,
      layer: "top",
      shape: "rect",
      soldermask_margin: MARGINE,
      is_covered_with_solder_mask: false,
      ...forma,
    },
  ];
}

const U1 = [-0.75, -0.25, 0.25, 0.75].flatMap((x, i) => piazzola("U1", `${i + 1}`, "k2", { x, y: 2, width: 0.3, height: 1 }));
const FL1 = [
  ...[-0.4, 0, 0.4].flatMap((x, i) => piazzola("FL1", `${i + 1}`, "k1", { x, y: 1 - 6, width: 0.2, height: 0.5 })),
  ...[-0.4, 0, 0.4].flatMap((x, i) => piazzola("FL1", `${i + 4}`, "k1", { x, y: -1 - 6, width: 0.2, height: 0.5 })),
  ...piazzola("FL1", "EP", "k1", { x: 0, y: -6, width: 1, height: 0.6 }),
];

/** the scene, its ports put on their nets by two source traces */
function scena(...altri: El[][]): El[] {
  const tutti = [...parte("U1", "U1"), ...parte("FL1", "FL1"), ...U1, ...FL1, ...altri.flat()];
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

/** U1's row: from x -0,9 to 0,9 and y 1,5 to 2,5, plus 0,051 all around */
const FILA_U1 = { pezzo: "U1", nome: "fila nord", forma: "rettangolo", x: 0, y: 2, w: 1.8 + 0.102, h: 1 + 0.102 };
/** FL1's two rows, 0,051 around each; the ground pad between them is left out */
const FILE_FL1 = [
  { pezzo: "FL1", nome: "fila nord", forma: "rettangolo", x: 0, y: -5, w: 1 + 0.102, h: 0.5 + 0.102 },
  {
    pezzo: "FL1",
    nome: "fila sud",
    forma: "poligono",
    punti: [
      { x: -0.551, y: -7.301 },
      { x: 0.551, y: -7.301 },
      { x: 0.551, y: -6.699 },
      { x: -0.551, y: -6.699 },
    ],
  },
];

const fileMaschera = (top: unknown[], bottom: unknown[] = []) => ({ [MASCHERA_PATH]: JSON.stringify({ top, bottom }) });
/** the board as the compile leaves it: the windows of the file on it */
const conFinestre = (els: El[], top: unknown[]) => conMascheraAMano(els, fileMaschera(top));

const drc = (els: El[], rules: DesignRules = DEFAULT_DESIGN_RULES) => runDrcChecks(els as never, rules);
const diRegola = (v: DrcViolation[], regola: string) => v.filter((x) => x.rule === regola);
/** every message of a rule, aggregated or not, with its count */
const conteggio = (v: DrcViolation[], regola: string) => diRegola(v, regola).reduce((n, x) => n + (x.count ?? 1), 0);

/** the Gerber layers of a board, through the export's path, with the creation date taken out */
function gerber(els: El[]): Record<string, string> {
  const strati = stringifyGerberCommandLayers(comandiConLaMaschera(els, (cj) => convertSoupToGerberCommands(cj as never)) as never);
  return Object.fromEntries(Object.entries(strati).map(([k, v]) => [k, senzaData(String(v))]));
}
const senzaData = (g: string) => g.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<data>");
/** how many pads are flashed, and how many regions are drawn, in a layer */
const lampi = (g: string) => (g.match(/D03\*/g) ?? []).length;
const regioni = (g: string) => (g.match(/G36\*/g) ?? []).length;

describe("one window for a whole row of pins", () => {
  it("is put on the board by the compile as a polygon in board coordinates, tied to its part", () => {
    const cj = conFinestre(scena(), [FILA_U1]);
    const [f] = cj.filter((e) => e.type === "pcb_soldermask_opening");
    expect(f).toMatchObject({ layer: "top", pezzo: "U1", nome: "fila nord", pcb_soldermask_opening_id: "pcb_soldermask_opening_top_0" });
    const xs = (f.points as Array<{ x: number; y: number }>).map((p) => p.x);
    const ys = (f.points as Array<{ x: number; y: number }>).map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(-0.951, 6);
    expect(Math.max(...xs)).toBeCloseTo(0.951, 6);
    expect(Math.min(...ys)).toBeCloseTo(1.449, 6);
    expect(Math.max(...ys)).toBeCloseTo(2.551, 6);
    // the window is the last thing on the board: nothing before it moved
    expect(cj.slice(0, -1)).toEqual(scena());
  });

  it("covers the four pads whole: they open none of their own", () => {
    const { aperture, coperte } = apertureAMano(conFinestre(scena(), [FILA_U1]) as never);
    expect(aperture).toHaveLength(1);
    expect([...coperte].sort()).toEqual(["pad_U1_1", "pad_U1_2", "pad_U1_3", "pad_U1_4"]);
    expect(aperture[0].nome).toBe("U1 fila nord");
  });

  it("the Gerber of the mask: one region for the row and no flash for its pads, the copper and the paste as before", () => {
    const prima = gerber(scena());
    const dopo = gerber(conFinestre(scena(), [FILA_U1]));
    // 4 pins of U1 + 7 pads of FL1, each with its own flash
    expect(lampi(prima.F_Mask)).toBe(11);
    expect(regioni(prima.F_Mask)).toBe(0);
    // FL1's seven keep theirs, U1's four are one window
    expect(lampi(dopo.F_Mask)).toBe(7);
    expect(regioni(dopo.F_Mask)).toBe(1);
    // the region is the window: its corners, in the Gerber's units (X-0.951 Y1.449 in 4.6 format)
    expect(dopo.F_Mask).toMatch(/X-0*951000Y0*1449000D02\*/);
    for (const strato of Object.keys(prima)) {
      if (strato === "F_Mask") continue;
      expect(dopo[strato], strato).toBe(prima[strato]);
    }
  });

  it("a pad only partly under a window keeps its own opening, and the two touching is said", () => {
    // a window that stops in the middle of pin 4
    const corta = { ...FILA_U1, nome: "fila corta", x: -0.2, w: 1.5 };
    const cj = conFinestre(scena(), [corta]);
    const { coperte } = apertureAMano(cj as never);
    expect([...coperte].sort()).toEqual(["pad_U1_1", "pad_U1_2", "pad_U1_3"]);
    expect(lampi(gerber(cj).F_Mask)).toBe(8);
    const [v] = diRegola(drc(cj), "solder_mask_bridge");
    expect(v.message).toContain("l'apertura a mano «U1 fila corta» e l'apertura di U1.4 si toccano (top)");
  });
});

describe("the ground pad in the middle of FL1", () => {
  it("is not touched: it keeps its own opening, with the mask between it and the rows", () => {
    const cj = conFinestre(scena(), FILE_FL1);
    const { aperture, coperte } = apertureAMano(cj as never);
    expect(aperture.map((a) => a.nome)).toEqual(["FL1 fila nord", "FL1 fila sud"]);
    expect(coperte.has("pad_FL1_EP")).toBe(false);
    expect([...coperte].filter((id) => id.startsWith("pad_FL1_")).sort()).toEqual(
      ["pad_FL1_1", "pad_FL1_2", "pad_FL1_3", "pad_FL1_4", "pad_FL1_5", "pad_FL1_6"],
    );
    const g = gerber(cj).F_Mask;
    // U1's four and the ground pad's: five flashes, two windows
    expect(lampi(g)).toBe(5);
    expect(regioni(g)).toBe(2);
    // the strip between a row and the ground pad: 0,699 - 0,35 = 0,349, nothing to say about FL1
    const dighe = diRegola(drc(cj), "solder_mask_bridge");
    expect(dighe.map((d) => d.message).join(" ")).not.toContain("FL1");
  });

  it("a window drawn over the ground pad's opening is said, by name", () => {
    const larga = { pezzo: "FL1", nome: "fila nord", forma: "rettangolo", x: 0, y: -5.3, w: 1.102, h: 1.2 };
    const v = diRegola(drc(conFinestre(scena(), [larga])), "solder_mask_bridge");
    expect(v.map((x) => x.message).join(" ")).toContain("l'apertura a mano «FL1 fila nord» e l'apertura di FL1.EP si toccano (top)");
  });
});

describe("the strip of mask between two openings (solder_mask_bridge)", () => {
  it("U1 and FL1 with an opening around every pin: strips of 0,100 mm, under the 0,1016 of PCB Basic, each with its red dot", () => {
    expect(DIGA_MASCHERA_MM).toBe(0.1016);
    const v = drc(scena());
    // three between the four pins of U1, two in each row of FL1 (pads 0,2 at pitch 0,4: 0,4 - 0,3)
    expect(conteggio(v, "solder_mask_bridge")).toBe(7);
    const [aggregata] = diRegola(v, "solder_mask_bridge");
    expect(aggregata.message).toMatch(/^7x solder_mask_bridge: diga di maschera di 0\.100mm fra l'apertura di (U1|FL1)\.\d e l'apertura di (U1|FL1)\.\d \(top\) < min 0\.1016mm/);
    const punti = aggregata.points ?? [];
    expect(punti).toHaveLength(7);
    // in the middle of the strip between U1's pin 1 and pin 2, on the top
    expect(punti.some((p) => Math.abs(p.x + 0.5) < 1e-6 && Math.abs(p.y - 2) < 0.6 && p.layer === "top")).toBe(true);
  });

  it("with a window over U1's row: no strip left there, FL1's four remain", () => {
    const v = drc(conFinestre(scena(), [FILA_U1]));
    expect(conteggio(v, "solder_mask_bridge")).toBe(4);
    expect((diRegola(v, "solder_mask_bridge")[0].points ?? []).every((p) => p.y < -4)).toBe(true);
    // and with FL1's two as well: none
    expect(conteggio(drc(conFinestre(scena(), [FILA_U1, ...FILE_FL1])), "solder_mask_bridge")).toBe(0);
  });

  it("one strip alone is said in full, with its point", () => {
    const due = [0, 0.5].flatMap((x, i) => piazzola("U1", `d${i}`, "k2", { x: x + 5, y: 8, width: 0.3, height: 0.5 }));
    const v = diRegola(drc(conFinestre(scena(due), [FILA_U1, ...FILE_FL1])), "solder_mask_bridge");
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe("diga di maschera di 0.100mm fra l'apertura di U1.d0 e l'apertura di U1.d1 (top) < min 0.1016mm");
    expect(v[0].points).toEqual([{ x: 5.25, y: expect.closeTo(8, 6), layer: "top" }]);
  });

  it("the project's number decides: at 0,08 the strips of 0,1 pass", () => {
    const regole = { ...DEFAULT_DESIGN_RULES, minSolderMaskBridgeMm: 0.08 };
    expect(conteggio(drc(scena(), regole), "solder_mask_bridge")).toBe(0);
  });

  it("two openings of pads that overlap are one window: nothing to say", () => {
    const fitte = [0, 0.3].flatMap((x, i) => piazzola("U1", `x${i}`, "k2", { x, y: 8, width: 0.3, height: 0.5 }));
    const v = diRegola(drc(scena(fitte)), "solder_mask_bridge");
    expect(v.map((x) => x.message).join(" ")).not.toContain("U1.x0");
  });

  it("the field of the rules: in the file of the tools, with its limits", () => {
    expect(campiDelleRegole()).toContain("minSolderMaskBridgeMm 0..1");
    expect("regole" in validaFileDelleRegole(JSON.stringify({ preset: "custom", rules: { minSolderMaskBridgeMm: 0.0762 } }))).toBe(true);
    expect(validaFileDelleRegole(JSON.stringify({ preset: "custom", rules: { minSolderMaskBridgeMm: 2 } }))).toEqual({
      errori: ["minSolderMaskBridgeMm: 2 fuori dai limiti 0..1"],
    });
  });
});

describe("a via against the opening drawn by hand (pad_opening_clearance)", () => {
  const R_VIA = 0.225;
  const via = (id: string, x: number, y: number, rete: "k1" | "k2"): El => ({
    type: "pcb_via",
    pcb_via_id: id,
    x,
    y,
    outer_diameter: 2 * R_VIA,
    hole_diameter: 0.2,
    layers: ["top", "bottom"],
    subcircuit_connectivity_map_key: rete,
  });

  it("is measured against the window: 0,03 mm from its edge is an error, named by the window", () => {
    // right of the window, which ends at x 0,951
    const v = via("v_sig", 0.951 + R_VIA + 0.03, 2, "k2");
    const senza = diRegola(drc(scena([v])), "pad_opening_clearance");
    // against the pad's own opening (to x 0,95) it was 0,031: the same side, said for the pin
    expect(senza[0].message).toContain("U1.4");
    const [conMano] = diRegola(drc(conFinestre(scena([v]), [FILA_U1])), "pad_opening_clearance");
    expect(conMano.message).toContain("corona a 0.030mm dall'apertura a mano «U1 fila nord» della maschera (top)");
    expect(conMano.message).toContain("< min 0.05mm");
    expect(conMano.points![0].layer).toBe("top");
  });

  it("a via between two pins, far from their own openings but inside the window: the ring enters the opening", () => {
    // between pin 2 and pin 3 at the edge of the row, outside the pads, inside the window
    const v = via("v_in", 0, 2.4, "k1");
    const [x] = diRegola(drc(conFinestre(scena([v]), [FILA_U1])), "pad_opening_clearance");
    expect(x.message).toContain("«U1 fila nord»");
    expect(x.message).toContain("la corona entra nell'apertura");
  });

  it("a via in a pad of its own net under a window is a via in the pad: not counted", () => {
    const v = via("v_pad", 0.25, 2, "k2");
    const x = diRegola(drc(conFinestre(scena([v]), [FILA_U1])), "pad_opening_clearance");
    expect(x.map((m) => m.message).join(" ")).not.toContain("v_pad");
  });

  it("a via pasted in the viewer is refused next to a window too, named by it", () => {
    // the window goes 0,3 mm past pin 4, so the copper is far enough and only the window is near
    const larga = { ...FILA_U1, nome: "fila larga", x: 0.15, w: 2.202 };
    const cj = conFinestre(scena([via("v_gnd", 8, 8, "k1")]), [larga]);
    const esito = provaViaNuova({
      circuitJson: cj,
      regole: DEFAULT_DESIGN_RULES,
      via: { net: "GND", corona: 2 * R_VIA, foro: 0.2, strati: ["top", "bottom"] },
      dove: { x: 1.251 + R_VIA + 0.03, y: 2 },
    });
    expect(esito.ok).toBe(false);
    expect(!esito.ok && esito.blocco.motivo).toBe(
      "bloccato dall'apertura a mano «U1 fila larga»: la corona sarebbe a 0,03 mm dall'apertura della maschera, servono 0,05 mm",
    );
    // a millimetre away: laid
    expect(provaViaNuova({ circuitJson: cj, regole: DEFAULT_DESIGN_RULES, via: { net: "GND", corona: 2 * R_VIA, foro: 0.2, strati: ["top", "bottom"] }, dove: { x: 2.5, y: 2 } }).ok).toBe(true);
  });
});

describe("the viewer", () => {
  it("draws the window on the mask layer and no ring around the pads it covers", () => {
    const scene = buildScene(conFinestre(scena(), [FILA_U1]) as unknown[])!;
    expect(scene.finestre).toHaveLength(1);
    expect(scene.finestre[0]).toMatchObject({ layer: "top", nome: "U1 fila nord" });
    expect(scene.finestre[0].points).toHaveLength(4);
    const u1 = scene.pads.filter((p) => p.id.startsWith("pad_U1_"));
    expect(u1.every((p) => p.sottoFinestra === true)).toBe(true);
    expect(scene.pads.find((p) => p.id === "pad_FL1_EP")?.sottoFinestra).toBeUndefined();
  });

  it("a board without windows: nothing new in the scene", () => {
    const scene = buildScene(scena() as unknown[])!;
    expect(scene.finestre).toEqual([]);
    expect(scene.pads.some((p) => "sottoFinestra" in p)).toBe(false);
  });
});

describe("a project without maschera.json", () => {
  it("the compile and the recheck give the board back as it came, the same array", () => {
    const cj = scena();
    expect(conMascheraAMano(cj, { "main.tsx": "x" })).toBe(cj);
    expect(circuitoPerLaMaschera(cj)).toBeNull();
    expect(avvisiDellaMaschera(cj, { "main.tsx": "x" })).toEqual([]);
  });

  it("the Gerber is the one of before, byte for byte, the date aside", () => {
    const cj = scena();
    const primaDiQuesto = stringifyGerberCommandLayers(convertSoupToGerberCommands(cj as never));
    const oggi = gerber(cj);
    expect(Object.keys(oggi).sort()).toEqual(Object.keys(primaDiQuesto).sort());
    for (const [strato, testo] of Object.entries(primaDiQuesto)) expect(oggi[strato], strato).toBe(senzaData(String(testo)));
  });

  it("the file taken away: the windows of a board of before go with it", () => {
    const conMano = conFinestre(scena(), [FILA_U1]);
    expect(conMascheraAMano(conMano, {})).toEqual(scena());
  });
});

describe("the file", () => {
  const scrivi = (dati: unknown, contorno?: Array<{ x: number; y: number }>) => validaFileDellaMaschera(JSON.stringify(dati), contorno);
  const errori = (dati: unknown, contorno?: Array<{ x: number; y: number }>) => {
    const esito = scrivi(dati, contorno);
    return "errori" in esito ? esito.errori.join("; ") : "";
  };
  const QUADRATO = [
    { x: -10, y: -10 },
    { x: 10, y: -10 },
    { x: 10, y: 10 },
    { x: -10, y: 10 },
  ];

  it("a right file is accepted whole", () => {
    expect(scrivi({ top: [FILA_U1, ...FILE_FL1], bottom: [] }, QUADRATO)).toMatchObject({ aperture: expect.any(Array) });
    const esito = scrivi({ top: [FILA_U1], bottom: [{ ...FILA_U1, rot: 45 }] }, QUADRATO);
    expect("aperture" in esito && esito.aperture.map((a) => a.lato)).toEqual(["top", "bottom"]);
  });

  it("a wrong one is refused, each reason by face and place", () => {
    expect(validaFileDellaMaschera("{ top: [")).toEqual({ errori: ["non e' un JSON valido (NaN e Infinity non sono JSON)"] });
    expect(validaFileDellaMaschera('{"top": [{"pezzo": "U1", "forma": "rettangolo", "x": NaN, "y": 0, "w": 1, "h": 1}]}')).toMatchObject({
      errori: [expect.stringContaining("JSON valido")],
    });
    expect(errori([1])).toContain("serve un oggetto");
    expect(errori({ top: [], lato: [] })).toContain("campo sconosciuto lato (ammessi top e bottom)");
    expect(errori({ top: {} })).toContain("top: serve un elenco di aperture");
    expect(errori({ top: [{ ...FILA_U1, forma: "cerchio" }] })).toContain('top[0].forma: deve essere "rettangolo" o "poligono"');
    expect(errori({ top: [{ ...FILA_U1, w: 0.01 }] })).toContain("top[0]: w e h, i lati in mm, devono essere numeri da 0.05 a 200");
    expect(errori({ top: [{ ...FILA_U1, x: "0" }] })).toContain("top[0]: x e y, il centro in mm sulla scheda, devono essere numeri");
    expect(errori({ top: [{ ...FILA_U1, rot: 1e9 }] })).toContain("top[0].rot");
    expect(errori({ top: [{ ...FILA_U1, colore: "verde" }] })).toContain("top[0]: un campo sconosciuto");
    expect(errori({ top: [{ ...FILA_U1, pezzo: undefined }] })).toContain("top[0].pezzo");
    expect(errori({ bottom: [FILA_U1, { ...FILA_U1, h: -1 }] })).toContain("bottom[1]");
    // a polygon: from 3 to MAX_VERTICI vertices, with area and no crossing sides
    expect(errori({ top: [{ pezzo: "U1", forma: "poligono", punti: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] })).toContain(`da 3 a ${MAX_VERTICI} vertici`);
    const tanti = Array.from({ length: MAX_VERTICI + 1 }, (_, i) => ({ x: Math.cos(i / 10), y: Math.sin(i / 10) }));
    expect(errori({ top: [{ pezzo: "U1", forma: "poligono", punti: tanti }] })).toContain(`da 3 a ${MAX_VERTICI} vertici`);
    expect(errori({ top: [{ pezzo: "U1", forma: "poligono", punti: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] }] })).toContain("non ha area");
    const farfalla = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
    expect(errori({ top: [{ pezzo: "U1", forma: "poligono", punti: farfalla }] })).toContain("due lati del poligono si incrociano");
    expect(errori({ top: [{ pezzo: "U1", forma: "poligono", punti: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1, z: 2 }] }] })).toContain('ogni vertice e\' {"x": ..., "y": ...}');
    expect(errori({ top: [{ ...FILA_U1, punti: [] }] })).toContain("un rettangolo si scrive con x, y, w, h e rot");
    // at most MAX_APERTURE_MASCHERA windows
    expect(errori({ top: Array.from({ length: MAX_APERTURE_MASCHERA + 1 }, () => FILA_U1) })).toContain(`troppe aperture (${MAX_APERTURE_MASCHERA + 1}, massimo ${MAX_APERTURE_MASCHERA}`);
  });

  it("every vertex on the board, when the board is known", () => {
    expect(errori({ top: [{ ...FILA_U1, x: 9.5 }] }, QUADRATO)).toContain("top[0]: esce dalla scheda");
    expect(errori({ top: [{ ...FILA_U1, x: 9.5 }] })).toBe("");
    expect(errori({ top: [{ ...FILA_U1, x: 5000 }] })).toContain("top[0]: x e y");
  });

  it("nothing of what was sent comes back in a message", () => {
    const e = errori({
      top: [
        { ...FILA_U1, pezzo: "U1'); DROP TABLE progetti;--" },
        { ...FILA_U1, nome: "<img src=x onerror=alert(1)>" },
        { ...FILA_U1, "../../segreti": 1 },
      ],
      "<script>": [],
    });
    expect(e).toContain("top[0].pezzo");
    expect(e).toContain("top[1].nome");
    expect(e).toContain("top[2]: un campo sconosciuto");
    expect(e).toContain("campo sconosciuto dal nome non valido");
    expect(e).not.toMatch(/DROP TABLE|onerror|segreti|<script>/);
  });

  it("at compile a broken entry is said and skipped, the others are put on the board", () => {
    const fs = fileMaschera([FILA_U1, { ...FILA_U1, forma: "ovale" }]);
    expect(leggiMaschera(fs).aperture).toHaveLength(1);
    expect(leggiMaschera(fs).avvisi).toEqual([`${MASCHERA_PATH}: top[1].forma: deve essere "rettangolo" o "poligono", saltata`]);
    const cj = conMascheraAMano(scena(), fs);
    expect(cj.filter((e) => e.type === "pcb_soldermask_opening")).toHaveLength(1);
    expect(avvisiDellaMaschera(cj, fs).map((a) => a.message)).toEqual([leggiMaschera(fs).avvisi[0]]);
    expect(leggiMaschera({ [MASCHERA_PATH]: "{" }).avvisi).toEqual([`${MASCHERA_PATH} non e' un JSON valido: ignorato`]);
  });

  it("at compile a window off the board, one for a part that is not there and one that covers nothing are said", () => {
    const fs = fileMaschera([
      { ...FILA_U1, nome: "fuori", x: 9.5 },
      { ...FILA_U1, pezzo: "U9", nome: "nessuno" },
      { ...FILA_U1, nome: "vuota", y: -2 },
    ]);
    const cj = conMascheraAMano(scena(), fs);
    expect(cj.filter((e) => e.type === "pcb_soldermask_opening").map((e) => e.nome)).toEqual(["nessuno", "vuota"]);
    const messaggi = avvisiDellaMaschera(cj, fs).map((a) => a.message);
    expect(messaggi).toEqual([
      `${MASCHERA_PATH}: l'apertura «U1 fuori» (top[0]) esce dalla scheda: non e' stata messa`,
      `${MASCHERA_PATH}: l'apertura «U9 nessuno» (top) e' per U9, che non e' sulla scheda`,
      expect.stringContaining(`${MASCHERA_PATH}: l'apertura «U1 vuota» (top) non copre per intero nessuna piazzola di U1`),
    ]);
  });
});
