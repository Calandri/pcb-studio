import { describe, expect, it } from "vitest";
import { summarizeCircuit } from "@/lib/compile";
import {
  buildProjectRules,
  conLoStackupDi,
  DESIGN_RULES_PATH,
  quoteDelloStackup,
  resolveDesignRules,
  resolveStackup,
  serializeDesignRules,
  validaFileDelleRegole,
  type Stackup,
} from "@/lib/design-rules";

/*
 * A project declares the board's real stackup in design-rules.json, next to
 * preset and rules (Niccolo', 2026-11-12, for st-camera: six layers, 1.6 mm).
 *
 * THE NUMBERS COME FROM THE SOURCE, never from what the code prints.
 * ST_CAMERA is the JLCPCB stack JLC06161H-3313 as jlcpcb.com/impedance gives
 * it. The depths are added up by hand, the upper face of each copper layer
 * from the Top face:
 *   L1 0
 *   L2 0,035 + 0,0994            = 0,1344
 *   L3 0,1344 + 0,0152 + 0,55    = 0,6996
 *   L4 0,6996 + 0,0152 + 0,1164  = 0,8312
 *   L5 0,8312 + 0,0152 + 0,55    = 1,3964
 *   L6 1,3964 + 0,0152 + 0,0994  = 1,5110
 *   all of it 1,5110 + 0,035     = 1,5460
 * The two- and four-layer stacks below are not a fab's: round numbers made up
 * for the test, added up by hand next to each.
 */
const ST_CAMERA: Stackup = {
  copperMm: [0.035, 0.0152, 0.0152, 0.0152, 0.0152, 0.035],
  dielectrics: [
    { mm: 0.0994, er: 4.1, kind: "prepreg", name: "3313" },
    { mm: 0.55, er: 4.6, kind: "core" },
    { mm: 0.1164, er: 4.16, kind: "prepreg", name: "2116" },
    { mm: 0.55, er: 4.6, kind: "core" },
    { mm: 0.0994, er: 4.1, kind: "prepreg", name: "3313" },
  ],
};
/** two layers: 0,035 + 1,53 = 1,565 for the Bottom; all of it 1,565 + 0,035 = 1,6 */
const DUE_STRATI: Stackup = { copperMm: [0.035, 0.035], dielectrics: [{ mm: 1.53 }] };
/** four layers: L2 0,035 + 0,2 = 0,235; L3 0,235 + 0,0175 + 1,1 = 1,3525; L4 1,3525 + 0,0175 + 0,2 = 1,57; all of it 1,57 + 0,035 = 1,605 */
const QUATTRO_STRATI: Stackup = {
  copperMm: [0.035, 0.0175, 0.0175, 0.035],
  dielectrics: [{ mm: 0.2, kind: "prepreg" }, { mm: 1.1, name: "FR4" }, { mm: 0.2, er: 4.4 }],
};

const file = (corpo: unknown) => ({ [DESIGN_RULES_PATH]: typeof corpo === "string" ? corpo : JSON.stringify(corpo) });
const valida = (corpo: unknown) => validaFileDelleRegole(typeof corpo === "string" ? corpo : JSON.stringify(corpo));
/** the reasons a file is refused, in one line; empty when it is accepted */
const motivi = (corpo: unknown): string => {
  const esito = valida(corpo);
  return "errori" in esito ? esito.errori.join("; ") : "";
};
const conPila = (stackup: unknown) => ({ preset: "jlcpcb_standard", stackup });

describe("le quote di una pila: la faccia di sopra di ogni strato, dalla faccia Top", () => {
  const vicino = (a: number[], b: number[]) => {
    expect(a).toHaveLength(b.length);
    a.forEach((v, i) => expect(v, `strato ${i + 1}`).toBeCloseTo(b[i], 9));
  };

  it("st-camera, JLC06161H-3313: 0 / 0,1344 / 0,6996 / 0,8312 / 1,3964 / 1,5110, in tutto 1,5460", () => {
    const { quoteMm, totaleMm } = quoteDelloStackup(ST_CAMERA);
    vicino(quoteMm, [0, 0.1344, 0.6996, 0.8312, 1.3964, 1.511]);
    expect(totaleMm).toBeCloseTo(1.546, 9);
  });

  it("due strati: 0 / 1,565, in tutto 1,6", () => {
    const { quoteMm, totaleMm } = quoteDelloStackup(DUE_STRATI);
    vicino(quoteMm, [0, 1.565]);
    expect(totaleMm).toBeCloseTo(1.6, 9);
  });

  it("quattro strati: 0 / 0,235 / 1,3525 / 1,57, in tutto 1,605", () => {
    const { quoteMm, totaleMm } = quoteDelloStackup(QUATTRO_STRATI);
    vicino(quoteMm, [0, 0.235, 1.3525, 1.57]);
    expect(totaleMm).toBeCloseTo(1.605, 9);
  });
});

describe("design-rules.json con la pila: accettato intero, scritto com'e'", () => {
  it("con un preset di fabbrica: preset e stackup, niente rules", () => {
    const esito = valida(conPila(ST_CAMERA));
    if ("errori" in esito) throw new Error(esito.errori.join("; "));
    expect(esito.stackup).toEqual(ST_CAMERA);
    expect(esito.regole).toMatchObject({ preset: "jlcpcb_standard", isCustom: false });
    expect(JSON.parse(esito.contenuto)).toEqual({ preset: "jlcpcb_standard", stackup: ST_CAMERA });
    // what is written reads back as the same stackup
    expect(resolveStackup(file(esito.contenuto))).toEqual({ stackup: ST_CAMERA });
  });

  it("con le regole a mano: preset, rules e stackup, in quest'ordine", () => {
    const esito = valida({ stackup: QUATTRO_STRATI, rules: { minTraceWidthMm: 0.15 }, preset: "custom" });
    if ("errori" in esito) throw new Error(esito.errori.join("; "));
    const scritto = JSON.parse(esito.contenuto) as Record<string, unknown>;
    expect(Object.keys(scritto)).toEqual(["preset", "rules", "stackup"]);
    expect(scritto.stackup).toEqual(QUATTRO_STRATI);
    expect(scritto.rules).toMatchObject({ minTraceWidthMm: 0.15 });
  });

  it("i facoltativi restano facoltativi e i limiti sono compresi: nome di 40 caratteri, er appena sopra 1, 10 mm", () => {
    const pila = { copperMm: [0.035, 0.035], dielectrics: [{ mm: 10, er: 1.0001, name: "x".repeat(40) }] };
    expect(motivi(conPila(pila))).toBe("");
    expect(motivi(conPila(DUE_STRATI))).toBe("");
  });

  it("un file senza pila resta valido e scritto come prima, alla lettera", () => {
    const fabbrica = valida({ preset: "oshpark" });
    if ("errori" in fabbrica) throw new Error(fabbrica.errori.join("; "));
    expect(fabbrica.contenuto).toBe('{\n  "preset": "oshpark"\n}\n');
    expect("stackup" in fabbrica).toBe(false);
    const aMano = valida({ preset: "custom", rules: { minTraceWidthMm: 0.15 } });
    if ("errori" in aMano) throw new Error(aMano.errori.join("; "));
    expect(Object.keys(JSON.parse(aMano.contenuto) as object)).toEqual(["preset", "rules"]);
    expect(aMano.contenuto).toBe(serializeDesignRules(buildProjectRules("custom", { minTraceWidthMm: 0.15 })));
  });
});

describe("design-rules.json con una pila sbagliata: rifiutato intero, col motivo", () => {
  const strato = { mm: 1.5 };
  const due = (dielettrico: unknown) => conPila({ copperMm: [0.035, 0.035], dielectrics: [dielettrico] });
  const casi: Array<[string, unknown, RegExp]> = [
    ["stackup non e' un oggetto: un elenco", conPila([]), /^stackup: serve un oggetto \{"copperMm": \[\.\.\.\], "dielectrics": \[\.\.\.\]\}$/],
    ["stackup non e' un oggetto: null", conPila(null), /^stackup: serve un oggetto/],
    ["stackup non e' un oggetto: un testo", conPila("JLC06161H-3313"), /^stackup: serve un oggetto/],
    ["un campo sconosciuto dentro stackup", conPila({ ...DUE_STRATI, totalMm: 1.6 }), /^stackup\.totalMm: campo sconosciuto \(ammessi copperMm e dielectrics\)$/],
    ["copperMm manca", conPila({ dielectrics: [strato] }), /stackup\.copperMm: serve un elenco di almeno due spessori in mm/],
    ["copperMm non e' un elenco", conPila({ copperMm: 0.035, dielectrics: [strato] }), /stackup\.copperMm: serve un elenco di almeno due spessori in mm/],
    ["un solo strato di rame", conPila({ copperMm: [0.035], dielectrics: [] }), /^stackup\.copperMm: serve un elenco di almeno due spessori in mm, uno per strato di rame, dall'alto \(Top\) al basso \(Bottom\)$/],
    ["rame a zero", conPila({ copperMm: [0.035, 0], dielectrics: [strato] }), /^stackup\.copperMm\[1\]: 0 deve essere maggiore di zero$/],
    ["rame negativo", conPila({ copperMm: [-0.035, 0.035], dielectrics: [strato] }), /^stackup\.copperMm\[0\]: -0\.035 deve essere maggiore di zero$/],
    ["rame scritto come testo", conPila({ copperMm: ["0.035", 0.035], dielectrics: [strato] }), /^stackup\.copperMm\[0\]: deve essere un numero di millimetri maggiore di zero$/],
    ["rame non finito", '{"preset": "oshpark", "stackup": {"copperMm": [1e999, 0.035], "dielectrics": [{"mm": 1.5}]}}', /^stackup\.copperMm\[0\]: deve essere un numero di millimetri maggiore di zero$/],
    ["rame in micron", conPila({ copperMm: [35, 35], dielectrics: [strato] }), /^stackup\.copperMm\[0\]: 35 oltre il massimo di 10 \(i valori sono in millimetri, non in micron\); stackup\.copperMm\[1\]: 35 oltre/],
    ["dielectrics manca", conPila({ copperMm: [0.035, 0.035] }), /^stackup\.dielectrics: serve un elenco, uno per ogni spazio fra due strati di rame, dall'alto$/],
    ["un dielettrico in meno", conPila({ ...ST_CAMERA, dielectrics: ST_CAMERA.dielectrics.slice(0, 4) }), /^stackup\.dielectrics: ne servono 5, uno per ogni spazio fra i 6 strati di rame \(trovati 4\)$/],
    ["un dielettrico in piu'", conPila({ ...ST_CAMERA, dielectrics: [...ST_CAMERA.dielectrics, strato] }), /^stackup\.dielectrics: ne servono 5, uno per ogni spazio fra i 6 strati di rame \(trovati 6\)$/],
    ["un dielettrico che non e' un oggetto", due(1.5), /^stackup\.dielectrics\[0\]: serve un oggetto \{"mm": \.\.\.\} \(facoltativi er, kind, name\)$/],
    ["mm manca", due({ kind: "core" }), /^stackup\.dielectrics\[0\]\.mm: manca, lo spessore in millimetri e' obbligatorio$/],
    ["mm a zero", due({ mm: 0 }), /^stackup\.dielectrics\[0\]\.mm: 0 deve essere maggiore di zero$/],
    ["mm negativo", due({ mm: -1.5 }), /^stackup\.dielectrics\[0\]\.mm: -1\.5 deve essere maggiore di zero$/],
    ["mm scritto come testo", due({ mm: "1.5" }), /^stackup\.dielectrics\[0\]\.mm: deve essere un numero di millimetri maggiore di zero$/],
    ["mm in micron", due({ mm: 99.4 }), /^stackup\.dielectrics\[0\]\.mm: 99\.4 oltre il massimo di 10/],
    ["er uguale a 1", due({ mm: 1.5, er: 1 }), /^stackup\.dielectrics\[0\]\.er: deve essere un numero maggiore di 1$/],
    ["er sotto 1", due({ mm: 1.5, er: 0.5 }), /^stackup\.dielectrics\[0\]\.er: deve essere un numero maggiore di 1$/],
    ["er scritto come testo", due({ mm: 1.5, er: "4.6" }), /^stackup\.dielectrics\[0\]\.er: deve essere un numero maggiore di 1$/],
    ["kind fuori dai due", due({ mm: 1.5, kind: "FR4" }), /^stackup\.dielectrics\[0\]\.kind: deve essere "prepreg" o "core"$/],
    ["kind con la maiuscola", due({ mm: 1.5, kind: "Core" }), /^stackup\.dielectrics\[0\]\.kind: deve essere "prepreg" o "core"$/],
    ["name vuoto", due({ mm: 1.5, name: "  " }), /^stackup\.dielectrics\[0\]\.name: deve essere un testo da 1 a 40 caratteri$/],
    ["name lungo 41", due({ mm: 1.5, name: "x".repeat(41) }), /^stackup\.dielectrics\[0\]\.name: deve essere un testo da 1 a 40 caratteri$/],
    ["name che non e' un testo", due({ mm: 1.5, name: 3313 }), /^stackup\.dielectrics\[0\]\.name: deve essere un testo da 1 a 40 caratteri$/],
    ["name su due righe", due({ mm: 1.5, name: "33\n13" }), /^stackup\.dielectrics\[0\]\.name: deve essere un testo da 1 a 40 caratteri$/],
    ["un campo sconosciuto in un dielettrico", due({ mm: 1.5, tanD: 0.02 }), /^stackup\.dielectrics\[0\]\.tanD: campo sconosciuto \(ammessi mm, er, kind, name\)$/],
    ["il secondo dielettrico, col suo numero", conPila({ ...QUATTRO_STRATI, dielectrics: [{ mm: 0.2 }, { mm: 0 }, { mm: 0.2 }] }), /^stackup\.dielectrics\[1\]\.mm: 0 deve essere maggiore di zero$/],
    ["la pila dentro rules", { preset: "custom", rules: { stackup: DUE_STRATI } }, /^rules\.stackup: campo sconosciuto$/],
    ["un altro campo accanto a preset", { preset: "oshpark", pila: DUE_STRATI }, /^pila: campo sconosciuto \(ammessi preset, rules e stackup\)$/],
  ];

  for (const [nome, corpo, atteso] of casi) {
    it(nome, () => {
      const esito = valida(corpo);
      expect("errori" in esito, "il file deve essere rifiutato").toBe(true);
      expect(motivi(corpo)).toMatch(atteso);
    });
  }

  it("piu' errori insieme si dicono tutti, e una pila sbagliata rifiuta anche le regole giuste", () => {
    const m = motivi({ preset: "custom", rules: { minTraceWidthMm: 0.15 }, stackup: { copperMm: [0.035, 0], dielectrics: [{ mm: 1.5, er: 1, kind: "x" }] } });
    expect(m).toBe(
      'stackup.copperMm[1]: 0 deve essere maggiore di zero; stackup.dielectrics[0].er: deve essere un numero maggiore di 1; stackup.dielectrics[0].kind: deve essere "prepreg" o "core"',
    );
  });

  it("niente di quello che e' stato mandato torna nel messaggio: solo nomi corti e numeri", () => {
    const m = motivi(conPila({ copperMm: [0.035, 0.035], dielectrics: [{ mm: 1.5, kind: "DROP TABLE progetti", name: 7, "../../segreti": 1 }], "<script>": 1 }));
    expect(m).toContain("stackup.un campo dal nome non valido: campo sconosciuto");
    expect(m).toContain("stackup.dielectrics[0].un campo dal nome non valido: campo sconosciuto");
    expect(m).not.toMatch(/DROP TABLE|segreti|script/);
  });
});

describe("la pila letta dai file del progetto", () => {
  it("nessun file, o un file senza pila: niente da dire", () => {
    expect(resolveStackup({})).toEqual({});
    expect(resolveStackup(file({ preset: "oshpark" }))).toEqual({});
    expect(resolveStackup(file({ preset: "custom", rules: { minTraceWidthMm: 0.15 } }))).toEqual({});
    // a file that is not JSON has no stackup to read: the rules already say the file is broken
    expect(resolveStackup(file("{ preset: oops"))).toEqual({});
  });

  it("una pila giusta e' quella; una sbagliata non si usa e dice perche'", () => {
    expect(resolveStackup(file(conPila(ST_CAMERA)))).toEqual({ stackup: ST_CAMERA });
    const sbagliata = resolveStackup(file(conPila({ copperMm: [0.035, 0], dielectrics: [{ mm: 1.5 }] })));
    expect(sbagliata.stackup).toBeUndefined();
    expect(sbagliata.errori).toEqual(["stackup.copperMm[1]: 0 deve essere maggiore di zero"]);
    expect(resolveStackup(file(conPila(null))).errori?.[0]).toMatch(/^stackup: serve un oggetto/);
  });
});

describe("le regole e i controlli non vedono la pila", () => {
  it("le regole lette da un file con la pila sono quelle dello stesso file senza", () => {
    const regole = { minTraceWidthMm: 0.15, minClearanceMm: 0.15, autoroute: false };
    expect(resolveDesignRules(file({ preset: "custom", rules: regole, stackup: ST_CAMERA }))).toEqual(resolveDesignRules(file({ preset: "custom", rules: regole })));
    expect(resolveDesignRules(file(conPila(ST_CAMERA)))).toEqual(resolveDesignRules(file({ preset: "jlcpcb_standard" })));
    // a wrong stackup is not a wrong rule: the rules read as they are, with no warning
    expect(resolveDesignRules(file(conPila({ copperMm: [1] }))).warnings).toBeUndefined();
  });

  it("il riepilogo di una scheda e' lo stesso con la pila e senza: nessun controllo cambia risposta", () => {
    // two traces of different nets 0,1 mm apart on six layers: a board with something to report
    const cj = [
      { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 20, height: 20, num_layers: 6, thickness: 1.6 },
      { type: "source_net", source_net_id: "n1", name: "A" },
      { type: "source_net", source_net_id: "n2", name: "B" },
      { type: "source_trace", source_trace_id: "st1", connected_source_net_ids: ["n1"], connected_source_port_ids: [] },
      { type: "source_trace", source_trace_id: "st2", connected_source_net_ids: ["n2"], connected_source_port_ids: [] },
      { type: "pcb_trace", pcb_trace_id: "t1", source_trace_id: "st1", route: [{ route_type: "wire", x: -5, y: 0, width: 0.2, layer: "inner3" }, { route_type: "wire", x: 5, y: 0, width: 0.2, layer: "inner3" }] },
      { type: "pcb_trace", pcb_trace_id: "t2", source_trace_id: "st2", route: [{ route_type: "wire", x: -5, y: 0.3, width: 0.2, layer: "inner3" }, { route_type: "wire", x: 5, y: 0.3, width: 0.2, layer: "inner3" }] },
    ];
    const regole = { minTraceWidthMm: 0.15, minClearanceMm: 0.15 };
    const senza = summarizeCircuit(cj, file({ preset: "custom", rules: regole }));
    const con = summarizeCircuit(cj, file({ preset: "custom", rules: regole, stackup: ST_CAMERA }));
    const fuori = summarizeCircuit(cj, file({ preset: "custom", rules: regole, stackup: DUE_STRATI }));
    expect(senza.drcViolations.length).toBeGreaterThan(0);
    expect(con).toEqual(senza);
    // nor does a stackup for another number of layers
    expect(fuori).toEqual(senza);
  });
});

describe("chi riscrive le regole non perde la pila (conLoStackupDi)", () => {
  const nuovo = serializeDesignRules(buildProjectRules("custom", { minTraceWidthMm: 0.2 }));

  it("la pila del file di prima entra in quello nuovo, uguale, dopo le regole nuove", () => {
    const prima = JSON.stringify({ preset: "custom", rules: { minTraceWidthMm: 0.15 }, stackup: ST_CAMERA });
    const scritto = JSON.parse(conLoStackupDi(prima, nuovo)) as { preset: string; rules: { minTraceWidthMm: number }; stackup: unknown };
    expect(Object.keys(scritto)).toEqual(["preset", "rules", "stackup"]);
    expect(scritto.stackup).toEqual(ST_CAMERA);
    expect(scritto.rules.minTraceWidthMm).toBe(0.2);
    // and it is still a file the strict check accepts
    expect(motivi(conLoStackupDi(prima, nuovo))).toBe("");
  });

  it("da regole a mano a un preset di fabbrica: resta", () => {
    const prima = JSON.stringify({ preset: "custom", rules: {}, stackup: QUATTRO_STRATI });
    expect(JSON.parse(conLoStackupDi(prima, serializeDesignRules(buildProjectRules("oshpark"))))).toEqual({ preset: "oshpark", stackup: QUATTRO_STRATI });
  });

  it("senza pila prima, il file nuovo e' quello di sempre, alla lettera", () => {
    expect(conLoStackupDi(JSON.stringify({ preset: "oshpark" }), nuovo)).toBe(nuovo);
    expect(conLoStackupDi(null, nuovo)).toBe(nuovo);
    expect(conLoStackupDi(undefined, nuovo)).toBe(nuovo);
    expect(conLoStackupDi("", nuovo)).toBe(nuovo);
    // a file that is not JSON has nothing that can be carried over
    expect(conLoStackupDi("{ preset: oops", nuovo)).toBe(nuovo);
  });

  it("una pila sbagliata resta com'era scritta: non sparisce, continua a essere detta", () => {
    const sbagliata = { copperMm: [0.035, 0], dielectrics: [{ mm: 1.5 }] };
    const scritto = conLoStackupDi(JSON.stringify({ preset: "oshpark", stackup: sbagliata }), nuovo);
    expect((JSON.parse(scritto) as { stackup: unknown }).stackup).toEqual(sbagliata);
    expect(resolveStackup(file(scritto)).errori).toEqual(["stackup.copperMm[1]: 0 deve essere maggiore di zero"]);
  });

  it("un file nuovo che ha gia' la sua pila la tiene", () => {
    const conLaSua = serializeDesignRules(buildProjectRules("oshpark"), DUE_STRATI);
    expect(conLoStackupDi(JSON.stringify({ preset: "oshpark", stackup: ST_CAMERA }), conLaSua)).toBe(conLaSua);
  });
});
