import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  circuitJsonToProjectFiles,
  commentSafe,
  contornoDaScrivere,
  etichetteDeiPin,
  footprintJsx,
  jsLiteral,
  nomiDeiComponenti,
  risolviNomiRete,
  valoreLeggibile,
  type El,
} from "@/lib/circuit-json-to-project";

/*
 * The importer WRITES CODE that the server later evaluates. These tests treat
 * the generated main.tsx the way the server does: they parse it as TSX and run
 * it, with a JSX factory that records what each element received. A string from
 * the file that escapes its literal would either break the parse or run — and
 * every payload below tries to set globalThis.__violato.
 */

interface Nodo {
  type: string;
  props: Record<string, unknown>;
  children: Nodo[];
}

const g = globalThis as { __violato?: unknown };
afterEach(() => {
  delete g.__violato;
});

function diagnosticiDiParse(sorgente: string): readonly ts.Diagnostic[] {
  const sf = ts.createSourceFile("main.tsx", sorgente, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  return (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
}

/** every call and every assignment in the source: generated code has none */
function chiamateEAssegnamenti(sorgente: string): string[] {
  const sf = ts.createSourceFile("main.tsx", sorgente, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const trovati: string[] = [];
  const visita = (n: ts.Node) => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n)) {
      trovati.push(n.getText(sf));
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      trovati.push(n.getText(sf));
    }
    ts.forEachChild(n, visita);
  };
  visita(sf);
  return trovati;
}

/** runs a module that default-exports (or exports) a JSX factory function */
function esegui(sorgente: string, esportato = "default"): Nodo {
  const out = ts.transpileModule(sorgente, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      jsxFactory: "h",
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
  });
  const exports: Record<string, unknown> = {};
  const h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Nodo => ({
    type,
    props: props ?? {},
    children: children.flat() as Nodo[],
  });
  new Function("exports", "h", out.outputText)(exports, h);
  return (exports[esportato] as (p?: unknown) => Nodo)({});
}

/** every element of the tree, footprints included */
function tutti(n: Nodo): Nodo[] {
  const out: Nodo[] = [n];
  const fp = n.props.footprint as Nodo | undefined;
  if (fp && typeof fp === "object" && "type" in fp) out.push(...tutti(fp));
  for (const c of n.children ?? []) if (c && typeof c === "object") out.push(...tutti(c));
  return out;
}

const OSTILI = [
  'chiude" /><chip name="X" />',
  'backslash \\" e poi',
  "${(globalThis.__violato = 1)}",
  "{(globalThis.__violato = 1)}",
  "*/ globalThis.__violato = 1; /*",
  "riga\nglobalThis.__violato = 1",
  "a capo\r\nglobalThis.__violato = 1",
  "separatore\u2028globalThis.__violato = 1",
  "paragrafo\u2029globalThis.__violato = 1",
  "</script><script>globalThis.__violato = 1</script>",
  "<!-- globalThis.__violato = 1",
  "\\",
  "'; globalThis.__violato = 1; '",
  "`; globalThis.__violato = 1; `",
];

/** a small board where every string the file controls is `ostile` */
function schedaOstile(ostile: string): El[] {
  return [
    { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 20, height: 10 },
    { type: "source_component", source_component_id: "s1", name: "U1", ftype: "simple_chip" },
    { type: "pcb_component", pcb_component_id: "p1", source_component_id: "s1", center: { x: 1, y: 1 }, layer: "top" },
    { type: "source_port", source_port_id: "sp1", source_component_id: "s1", name: ostile, pin_number: 1 },
    { type: "source_port", source_port_id: "sp2", source_component_id: "s1", name: "2", pin_number: 2 },
    {
      type: "pcb_smtpad",
      pcb_smtpad_id: "pad1",
      pcb_component_id: "p1",
      x: 0.5,
      y: 1,
      width: 0.4,
      height: 0.6,
      shape: "rect",
      layer: ostile,
      port_hints: [ostile],
    },
    {
      type: "pcb_silkscreen_text",
      pcb_silkscreen_text_id: "t1",
      pcb_component_id: "p1",
      x: 1,
      y: 2,
      text: ostile,
      layer: ostile,
    },
    { type: "pcb_silkscreen_text", pcb_silkscreen_text_id: "t2", x: -5, y: -3, text: ostile, layer: "bottom" },
    { type: "source_component", source_component_id: "s2", name: "R1", ftype: "simple_resistor", display_value: ostile },
    { type: "pcb_component", pcb_component_id: "p2", source_component_id: "s2", center: { x: 5, y: 1 } },
    { type: "source_port", source_port_id: "sp3", source_component_id: "s2", name: "pin1", pin_number: 1 },
    { type: "pcb_smtpad", pcb_smtpad_id: "pad3", pcb_component_id: "p2", x: 5, y: 1, width: 0.5, height: 0.5, shape: "rect", port_hints: ["1"] },
    { type: "source_trace", source_trace_id: "tr1", connected_source_port_ids: ["sp1", "sp3"] },
    { type: "source_net", source_net_id: "n1", name: ostile },
    { type: "source_trace", source_trace_id: "tr2", connected_source_port_ids: ["sp2", "sp3"], connected_source_net_ids: ["n1"] },
  ];
}

describe("generated main.tsx with hostile strings from the file", () => {
  for (const ostile of OSTILI) {
    it(`keeps ${JSON.stringify(ostile)} a string`, () => {
      const { fsMap, warnings } = circuitJsonToProjectFiles(schedaOstile(ostile), {
        origine: `Importato da ${ostile}`,
        identita: new Map([
          ["U1", { mpn: ostile, descrizione: ostile, produttore: ostile, pattern: ostile, valore: ostile }],
        ]),
        corpi3d: new Map([["U1", { url: ostile }]]),
        piani: [{ faccia: ostile, net: ostile }, { faccia: "top", net: ostile }],
        schematica: {
          perComponente: new Map([
            ["U1", { sezione: ostile, lati: { sinistra: [ostile, "2", "3"], destra: ["4", "5"], su: [], giu: [] } }],
          ]),
          sezioni: [{ nome: ostile, titolo: ostile }],
        },
      });
      const main = fsMap["main.tsx"];
      expect(diagnosticiDiParse(main)).toEqual([]);
      expect(chiamateEAssegnamenti(main)).toEqual([]);

      const albero = esegui(main);
      expect(g.__violato).toBeUndefined();
      const nodi = tutti(albero);

      // silkscreen text, inside the footprint and on the board, verbatim
      const testi = nodi.filter((n) => n.type === "silkscreentext");
      expect(testi.map((t) => t.props.text)).toEqual([ostile, ostile]);
      // a layer from the file never reaches the code: it is read as top
      expect(testi[0].props.layer).toBe("top");

      const u1 = nodi.find((n) => n.props.name === "U1")!;
      const comprimi = (v: string) => v.replace(/\s+/g, " ").trim();
      expect(u1.props.manufacturerPartNumber).toBe(comprimi(ostile).slice(0, 120));
      expect((u1.props.pinLabels as Record<string, string>).pin1).toBe(ostile);
      expect((u1.props.cadModel as { objUrl: string }).objUrl).toBe(ostile);
      expect(u1.props.schSectionName).toBe(ostile);
      const disposizione = u1.props.schPinArrangement as { leftSide: { pins: string[] } };
      expect(disposizione.leftSide.pins[0]).toBe(ostile);
      const pad = nodi.find((n) => n.type === "smtpad" && Array.isArray(n.props.portHints) && (n.props.portHints as string[])[0] === ostile);
      expect(pad?.props.layer).toBe("top");

      // the resistor's value is not a quantity: not written, the part is a chip
      const r1 = nodi.find((n) => n.props.name === "R1")!;
      expect(r1.type).toBe("chip");
      expect(r1.props.resistance).toBeUndefined();

      // connections are still there, as string selectors
      const tracce = nodi.filter((n) => n.type === "trace");
      expect(tracce.length).toBe(3);
      for (const t of tracce) expect(String(t.props.from)).toMatch(/^\.(U1|R1) > \./);

      // a pour on a face that does not exist is dropped, the real one stays
      expect(nodi.filter((n) => n.type === "copperpour").map((n) => n.props.layer)).toEqual(["top"]);

      const sezione = nodi.find((n) => n.type === "schematicsection")!;
      expect(sezione.props.name).toBe(ostile);
      expect(sezione.props.displayName).toBe(ostile);
      expect(Array.isArray(warnings)).toBe(true);
    });
  }
});

describe("jsLiteral and commentSafe", () => {
  it("escapes the characters JSON leaves raw", () => {
    const s = jsLiteral("a\u2028b\u2029c</script><!--");
    expect(s).not.toMatch(/[\u2028\u2029]/);
    expect(s).not.toContain("</");
    expect(s).not.toContain("<!");
    expect(new Function(`return ${s}`)()).toBe("a\u2028b\u2029c</script><!--");
  });

  it("never lets a __proto__ key through", () => {
    const s = jsLiteral(JSON.parse('{"__proto__": {"x": 1}, "pin1": "A"}'));
    expect(s).toBe('{"pin1":"A"}');
  });

  it("turns every line terminator into a space and caps the length", () => {
    const c = commentSafe("a\nb\rc\u2028d\u2029e */ f\u0000g", 200);
    expect(c).toBe("a b c d e * / f g");
    expect(commentSafe("x".repeat(500), 50)).toHaveLength(50);
    const codice = `// ${commentSafe("nome\u2028globalThis.__violato = 1")}\nexport default 1`;
    new Function("exports", ts.transpileModule(codice, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)({});
    expect(g.__violato).toBeUndefined();
  });
});

describe("component names", () => {
  it("dedupes designators that clean up to the same name, and names the nameless", () => {
    const cj: El[] = [
      { type: "source_component", source_component_id: "a", name: "C_1" },
      { type: "source_component", source_component_id: "b", name: "C-1" },
      { type: "source_component", source_component_id: "c", name: "" },
      { type: "source_component", source_component_id: "d", name: "K3" },
    ];
    const nomi = nomiDeiComponenti(cj);
    expect(nomi.perId.get("a")).toBe("C_1");
    expect(nomi.perId.get("b")).toBe("C_1_2");
    // the real K3 keeps its name, the nameless part gets another
    expect(nomi.perId.get("d")).toBe("K3");
    expect(nomi.perId.get("c")).toBe("K3_2");
    expect(nomi.perDesignator.get("C-1")).toBe("C_1_2");
    expect(nomi.avvisi.length).toBe(2);
  });

  it("keeps the connections of a component that had no name", () => {
    const cj: El[] = [
      { type: "source_component", source_component_id: "a", name: "" },
      { type: "source_port", source_port_id: "pa", source_component_id: "a", name: "pin1", pin_number: 1 },
      { type: "source_component", source_component_id: "b", name: "R1" },
      { type: "source_port", source_port_id: "pb", source_component_id: "b", name: "pin1", pin_number: 1 },
      { type: "source_trace", source_trace_id: "t", connected_source_port_ids: ["pa", "pb"] },
    ];
    const { fsMap, traces, warnings } = circuitJsonToProjectFiles(cj, { origine: "test" });
    expect(traces).toBe(1);
    expect(fsMap["main.tsx"]).toContain('<chip name="K1"');
    expect(warnings.some((w) => /senza designator/.test(w))).toBe(true);
  });

  it("gives a net the number when a component already has its name", () => {
    const cj: El[] = [
      { type: "source_component", source_component_id: "a", name: "GND" },
      { type: "source_net", source_net_id: "n", name: "GND" },
    ];
    expect(risolviNomiRete(cj)("GND")).toBe("GND_2");
  });
});

describe("passive values", () => {
  it("writes only what is a number followed by a unit", () => {
    expect(valoreLeggibile("10 kOhms")).toBe("10kohm");
    expect(valoreLeggibile("4,7uF")).toBe("4.7uF");
    expect(valoreLeggibile("4k7")).toBe("4.7k");
    expect(valoreLeggibile("4R7")).toBe("4.7");
    expect(valoreLeggibile('10k" /><x')).toBeNull();
    expect(valoreLeggibile("${x}")).toBeNull();
    expect(valoreLeggibile("")).toBeNull();
  });
});

describe("pin labels of a reusable footprint", () => {
  it("labels pad n as pin n, gaps included", () => {
    const pad = (n: string): El => ({ type: "pcb_smtpad", port_hints: [n], x: 0, y: 0, width: 1, height: 1 });
    const etichette = etichetteDeiPin([pad("5"), pad("1"), pad("4"), pad("2"), pad("SH")]);
    expect(new Function(`return ${etichette}`)()).toEqual({ pin1: "1", pin2: "2", pin4: "4", pin5: "5" });
  });
});

/** a footprint body inside a component, run and flattened */
function footprintEseguito(elementi: El[], ctx = {}): Nodo[] {
  const corpo = footprintJsx(elementi, ctx, "      ");
  const albero = esegui(`export default () => (<chip footprint={<footprint>\n${corpo}\n</footprint>} />)`);
  return tutti(albero).filter((n) => n.type !== "chip" && n.type !== "footprint");
}

describe("plated holes keep their shape", () => {
  it("pill and oval", () => {
    const [pill] = footprintEseguito([
      { type: "pcb_plated_hole", shape: "pill", x: 0, y: 0, outer_width: 1, outer_height: 2.4, hole_width: 0.6, hole_height: 1.8, ccw_rotation: 0, port_hints: ["S1"] },
    ]);
    expect(pill.props).toMatchObject({ shape: "pill", outerWidth: 1, outerHeight: 2.4, holeWidth: 0.6, holeHeight: 1.8 });
    expect(pill.props.pcbRotation).toBeUndefined();
  });

  it("a slot turned by a quarter swaps its sides, any other angle is written", () => {
    const [quarto, obliquo] = footprintEseguito([
      { type: "pcb_plated_hole", shape: "oval", x: 0, y: 0, outer_width: 1, outer_height: 2, hole_width: 0.5, hole_height: 1.5, ccw_rotation: 90 },
      { type: "pcb_plated_hole", shape: "pill", x: 3, y: 0, outer_width: 1, outer_height: 2, hole_width: 0.5, hole_height: 1.5, ccw_rotation: 30 },
    ]);
    expect(quarto.props).toMatchObject({ shape: "oval", outerWidth: 2, outerHeight: 1, holeWidth: 1.5, holeHeight: 0.5 });
    expect(obliquo.props).toMatchObject({ shape: "pill", outerWidth: 1, outerHeight: 2, pcbRotation: 30 });
  });

  it("rotation is relative to the component, and mirrored underneath", () => {
    const [sopra] = footprintEseguito(
      [{ type: "pcb_plated_hole", shape: "pill", x: 0, y: 0, outer_width: 1, outer_height: 2, hole_width: 0.5, hole_height: 1.5, ccw_rotation: 120 }],
      { rotationDeg: 90 },
    );
    expect(sopra.props.pcbRotation).toBe(30);
    const [sotto] = footprintEseguito(
      [{ type: "pcb_plated_hole", shape: "pill", x: 0, y: 0, outer_width: 1, outer_height: 2, hole_width: 0.5, hole_height: 1.5, ccw_rotation: 30 }],
      { sotto: true },
    );
    expect(sotto.props.pcbRotation).toBe(150);
  });

  it("round hole in a rectangular pad, with its corner and offset", () => {
    const [h] = footprintEseguito([
      {
        type: "pcb_plated_hole",
        shape: "circular_hole_with_rect_pad",
        x: 0,
        y: 0,
        hole_diameter: 0.8,
        rect_pad_width: 1.6,
        rect_pad_height: 1.2,
        rect_border_radius: 0.1,
        rect_ccw_rotation: 90,
        hole_offset_x: 0.2,
        hole_offset_y: 0,
      },
    ]);
    expect(h.props).toMatchObject({
      shape: "circular_hole_with_rect_pad",
      holeDiameter: 0.8,
      rectPadWidth: 1.2,
      rectPadHeight: 1.6,
      rectBorderRadius: 0.1,
      holeOffsetX: 0,
      holeOffsetY: 0.2,
    });
  });

  it("slot in a rectangular pad, rotated variant included", () => {
    const [dritto, ruotato] = footprintEseguito([
      { type: "pcb_plated_hole", shape: "pill_hole_with_rect_pad", x: 0, y: 0, hole_width: 0.6, hole_height: 1.6, rect_pad_width: 1, rect_pad_height: 2.2 },
      {
        type: "pcb_plated_hole",
        shape: "rotated_pill_hole_with_rect_pad",
        x: 3,
        y: 0,
        hole_width: 0.6,
        hole_height: 1.6,
        rect_pad_width: 1,
        rect_pad_height: 2.2,
        hole_ccw_rotation: 45,
        rect_ccw_rotation: 45,
      },
    ]);
    expect(dritto.props).toMatchObject({ shape: "pill_hole_with_rect_pad", holeWidth: 0.6, holeHeight: 1.6, rectPadWidth: 1, rectPadHeight: 2.2 });
    expect(ruotato.props).toMatchObject({ shape: "pill_hole_with_rect_pad", holeWidth: 0.6, holeHeight: 1.6, pcbRotation: 45 });
  });

  it("polygon pad", () => {
    const [h] = footprintEseguito([
      {
        type: "pcb_plated_hole",
        shape: "hole_with_polygon_pad",
        x: 0,
        y: 0,
        hole_shape: "circle",
        hole_diameter: 0.7,
        pad_outline: [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 0, y: 1 }],
        hole_offset_x: 0,
        hole_offset_y: 0,
      },
    ]);
    expect(h.props).toMatchObject({ shape: "hole_with_polygon_pad", holeShape: "circle", holeDiameter: 0.7 });
    expect((h.props.padOutline as unknown[]).length).toBe(3);
  });

  it("an unknown shape is a round pad and a warning, never a silent guess", () => {
    const avvisi: string[] = [];
    const [h] = footprintEseguito(
      [{ type: "pcb_plated_hole", shape: "stella", x: 0, y: 0, hole_diameter: 0.5, outer_width: 1.2 }],
      { avvisi },
    );
    expect(h.props).toMatchObject({ shape: "circle", holeDiameter: 0.5, outerDiameter: 1.2 });
    expect(avvisi.length).toBe(1);
  });
});

describe("holes without copper", () => {
  it("slots and rectangles are written, in board frame", () => {
    const nodi = footprintEseguito(
      [
        { type: "pcb_hole", hole_shape: "pill", x: 0, y: 0, hole_width: 0.6, hole_height: 1.4 },
        { type: "pcb_hole", hole_shape: "rect", x: 1, y: 0, hole_width: 1, hole_height: 2 },
        { type: "pcb_hole", hole_shape: "rotated_pill", x: 2, y: 0, hole_width: 0.6, hole_height: 1.4, ccw_rotation: 90 },
        { type: "pcb_hole", hole_shape: "rotated_pill", x: 3, y: 0, hole_width: 0.6, hole_height: 1.4, ccw_rotation: 30 },
        { type: "pcb_hole", hole_shape: "circle", x: 4, y: 0, hole_diameter: 1.1 },
      ],
      // tscircuit does not turn holes with their part: the component's rotation must not change them
      { rotationDeg: 90 },
    );
    expect(nodi.map((n) => n.props)).toMatchObject([
      { shape: "pill", width: 0.6, height: 1.4 },
      { shape: "rect", width: 1, height: 2 },
      { shape: "pill", width: 1.4, height: 0.6 },
      { shape: "pill", width: 0.6, height: 1.4, pcbRotation: 30 },
      { diameter: 1.1 },
    ]);
  });

  it("a board-level slot is no longer dropped", () => {
    const { fsMap } = circuitJsonToProjectFiles(
      [{ type: "pcb_hole", pcb_hole_id: "h", hole_shape: "pill", x: 1, y: 2, hole_width: 1, hole_height: 3 }],
      { origine: "test" },
    );
    expect(fsMap["main.tsx"]).toContain('<hole shape="pill" width={1} height={3} pcbX={1} pcbY={2} />');
  });
});

describe("smd pads", () => {
  it("pill pads and rounded rectangles", () => {
    const [pill, angolo] = footprintEseguito([
      { type: "pcb_smtpad", shape: "pill", x: 0, y: 0, width: 0.6, height: 1.6, radius: 0.3, ccw_rotation: 90, layer: "top" },
      { type: "pcb_smtpad", shape: "rect", x: 1, y: 0, width: 1.5, height: 0.3, rect_border_radius: 0.05, layer: "top" },
    ]);
    expect(pill.props).toMatchObject({ shape: "pill", width: 1.6, height: 0.6, radius: 0.3 });
    expect(angolo.props).toMatchObject({ shape: "rect", width: 1.5, height: 0.3, cornerRadius: 0.05 });
  });
});

describe("board outline", () => {
  it("a rectangle stays width and height", () => {
    expect(contornoDaScrivere([{ x: -10, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 5 }, { x: -10, y: 5 }, { x: -10, y: -5 }])).toBeNull();
  });

  it("an L shaped board is written as its outline", () => {
    const elle = [
      { x: -10, y: -5 },
      { x: 10, y: -5 },
      { x: 10, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 5 },
      { x: -10, y: 5 },
      { x: -10, y: -5 },
    ];
    const c = contornoDaScrivere(elle)!;
    expect(c.punti.length).toBe(6);
    expect(c).toMatchObject({ larghezza: 20, altezza: 10 });
    const { fsMap } = circuitJsonToProjectFiles(
      [{ type: "pcb_board", pcb_board_id: "b", width: 20, height: 10, outline: elle }],
      { origine: "test" },
    );
    const board = esegui(fsMap["main.tsx"]);
    expect(board.props.width).toBe("20mm");
    expect((board.props.outline as unknown[]).length).toBe(6);
  });

  it("garbage is not an outline", () => {
    expect(contornoDaScrivere("no")).toBeNull();
    expect(contornoDaScrivere([{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }, { x: 1, y: "2" }])).toBeNull();
  });
});
