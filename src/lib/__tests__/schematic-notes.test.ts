import { describe, expect, it } from "vitest";
import { buildSchematicModel, type SchematicModel } from "@/lib/schematic-model";
import {
  SCHEMATIC_NOTES_MAX_BYTES,
  SCHEMATIC_NOTES_PATH,
  parseSchematicNotes,
  schematicNotesOf,
  validateSchematicNotesFile,
  withSchematicNotes,
} from "@/lib/schematic-notes";
import { overlaps, textBox, type Box } from "@/lib/schematic-shapes";
import {
  LONG_RAIL_PARTS,
  LONG_SIGNAL_PARTS,
  findJunctions,
  pieceSize,
  wireAsLabels,
  wireEnds,
} from "@/lib/schematic-wires";
import { filesHash } from "@/lib/project-store";
import { renderSchematicSvg } from "@/components/schematic/render-svg";
import { SHEET_PALETTES, showsLabel } from "@/components/schematic/SchematicSheet";

/*
 * A row of resistors in the shape tscircuit emits (y up), size 0.6 x 0.65 so
 * the typical part is 0.65:
 *   R1 at x=0, R3 at x=1.5, R4 at (3.3, -1), R2 far away at x=10.
 * Wires: R1-R3 short (signal SIG), R1-R2 long (signal SIG, 13.4 long),
 * R3-R4 on GND (2.2 long, beyond the rail threshold).
 */
function row(): unknown[] {
  const out: unknown[] = [
    { type: "source_net", source_net_id: "sn_sig", name: "SIG", subcircuit_connectivity_map_key: "k_sig" },
    { type: "source_net", source_net_id: "sn_gnd", name: "GND", is_ground: true, subcircuit_connectivity_map_key: "k_gnd" },
  ];
  const resistor = (name: string, x: number, y: number) => {
    out.push(
      { type: "source_component", source_component_id: `sc_${name}`, ftype: "simple_resistor", name, display_resistance: "10kΩ" },
      {
        type: "schematic_component",
        schematic_component_id: name,
        source_component_id: `sc_${name}`,
        center: { x, y },
        size: { width: 0.6, height: 0.65 },
        symbol_name: "boxresistor_right",
      },
    );
    for (const [pin, dx] of [
      [1, -0.3],
      [2, 0.3],
    ] as const) {
      out.push({
        type: "schematic_port",
        schematic_port_id: `${name}p${pin}`,
        schematic_component_id: name,
        source_port_id: `s_${name}p${pin}`,
        center: { x: x + dx, y },
        pin_number: pin,
        side_of_component: dx < 0 ? "left" : "right",
      });
    }
  };
  resistor("R1", 0, 0);
  resistor("R3", 1.5, 0);
  resistor("R4", 3.3, -1);
  resistor("R2", 10, 0);
  const trace = (id: string, key: string, pts: Array<[number, number]>) => {
    const edges = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      edges.push({ from: { x: pts[i][0], y: pts[i][1] }, to: { x: pts[i + 1][0], y: pts[i + 1][1] } });
    }
    out.push({ type: "schematic_trace", schematic_trace_id: id, subcircuit_connectivity_map_key: key, edges, junctions: [] });
  };
  trace("t_short", "k_sig", [
    [0.3, 0],
    [1.2, 0],
  ]);
  trace("t_long", "k_sig", [
    [0.3, 0],
    [0.5, 0],
    [0.5, 2],
    [9.5, 2],
    [9.5, 0],
    [9.7, 0],
  ]);
  trace("t_gnd", "k_gnd", [
    [1.8, 0],
    [2.0, 0],
    [2.0, -1],
    [3.0, -1],
  ]);
  out.push(
    { type: "source_trace", source_trace_id: "st1", connected_source_port_ids: ["s_R1p2", "s_R3p1", "s_R2p1"], subcircuit_connectivity_map_key: "k_sig" },
    { type: "source_trace", source_trace_id: "st2", connected_source_port_ids: ["s_R3p2", "s_R4p1"], subcircuit_connectivity_map_key: "k_gnd" },
  );
  return out;
}

const notes = (value: unknown) => parseSchematicNotes(JSON.stringify(value));

describe("schematico.json", () => {
  it("no file, no notes: the sheet stays the one of today", () => {
    expect(parseSchematicNotes(undefined)).toBeNull();
    expect(parseSchematicNotes("")).toBeNull();
    expect(parseSchematicNotes("   ")).toBeNull();
  });

  it("reads sections, comments and net names", () => {
    const n = notes({
      sezioni: [{ nome: "caricatore", titolo: "Caricatore BQ24210", pezzi: ["IC1", "C16"] }, { nome: "mcu", pezzi: ["U1"] }],
      commenti: { C16: "100 nF sull'ingresso VUSB" },
      reti: { M_NetC1_1: "U10.VBAT" },
    })!;
    expect(n.sections).toEqual([
      { name: "caricatore", title: "Caricatore BQ24210", pieces: ["IC1", "C16"] },
      { name: "mcu", title: "mcu", pieces: ["U1"] },
    ]);
    expect(n.comments.get("C16")).toBe("100 nF sull'ingresso VUSB");
    expect(n.nets.get("M_NetC1_1")).toBe("U10.VBAT");
    expect(n.warnings).toEqual([]);
  });

  it("a broken file is ignored with a warning, never thrown", () => {
    for (const raw of ["{not json", "[1, 2]", "42", "null"]) {
      const n = parseSchematicNotes(raw)!;
      expect(n.sections).toEqual([]);
      expect(n.comments.size).toBe(0);
      expect(n.warnings.length).toBeGreaterThan(0);
    }
    const huge = parseSchematicNotes(`{"commenti": {"R1": "${"x".repeat(SCHEMATIC_NOTES_MAX_BYTES)}"}}`)!;
    expect(huge.comments.size).toBe(0);
    expect(huge.warnings[0]).toMatch(/troppo grande/);
  });

  it("odd entries are skipped, the rest is kept", () => {
    const n = notes({
      sezioni: [{ titolo: "senza nome" }, "testo", { nome: "a", pezzi: ["R1", 7, "R2"] }, { nome: "b", pezzi: ["R2", "R3"] }, { nome: "a", pezzi: ["R9"] }],
      commenti: { R1: 12, R2: "ok" },
      reti: ["non", "un", "oggetto"],
    })!;
    expect(n.sections.map((s) => [s.name, s.pieces])).toEqual([
      ["a", ["R1", "R2"]],
      ["b", ["R3"]],
    ]);
    expect([...n.comments]).toEqual([["R2", "ok"]]);
    expect(n.nets.size).toBe(0);
    expect(n.warnings.join(" | ")).toMatch(/R2 e' gia' nella sezione a/);
  });

  it("user text is one clean line: no control or bidi characters, length capped", () => {
    const n = notes({
      sezioni: [{ nome: "x", titolo: `riga\nnuova\u202E rovescio\u0000`, pezzi: [] }],
      commenti: { R1: "a".repeat(1000) },
    })!;
    expect(n.sections[0].title).toBe("riga nuova rovescio");
    expect(n.comments.get("R1")!.length).toBeLessThanOrEqual(300);
  });

  it("a __proto__ key is a plain entry, it pollutes nothing", () => {
    const n = parseSchematicNotes('{"commenti": {"__proto__": "x", "R1": "y"}, "reti": {"__proto__": "z"}}')!;
    expect(n.comments.get("__proto__")).toBe("x");
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("z");
  });

  it("write_file accepts it only as a JSON object within the size limit", () => {
    expect(validateSchematicNotesFile('{"sezioni": []}')).toBeNull();
    expect(validateSchematicNotesFile("{oops")).toMatch(/not valid JSON/);
    expect(validateSchematicNotesFile("[1]")).toMatch(/JSON object/);
    expect(validateSchematicNotesFile(`{"a": "${"x".repeat(SCHEMATIC_NOTES_MAX_BYTES)}"}`)).toMatch(/too large/);
  });

  it("is not a compile source: writing it does not make the board stale", () => {
    const files = { "main.tsx": "export default () => null" };
    expect(filesHash({ ...files, [SCHEMATIC_NOTES_PATH]: '{"commenti": {}}' })).toBe(filesHash(files));
    expect(filesHash({ ...files, "other.json": "{}" })).not.toBe(filesHash(files));
  });

  it("rides along with the Circuit JSON to the sheet, and only when there is a file", () => {
    const cj = row();
    expect(withSchematicNotes(cj, undefined)).toBe(cj);
    const withNotes = withSchematicNotes(cj, '{"commenti": {"R1": "ciao"}}');
    expect(withNotes).toHaveLength(cj.length + 1);
    expect(schematicNotesOf(withNotes)?.comments.get("R1")).toBe("ciao");
  });
});

describe("long wires drawn as labels", () => {
  const piece = 0.65;
  const box = { minX: 0, minY: 0, maxX: 2, maxY: 1 };
  const wire = (length: number, power = false, endSections: Array<string | null> = [null, null], points = [{ x: 1, y: 0.5 }]) =>
    wireAsLabels({ length, power, endSections, points }, piece, (s) => (s === "a" ? box : null));

  it("the threshold: signals beyond 6 typical parts, rails beyond 2", () => {
    expect(LONG_SIGNAL_PARTS).toBe(6);
    expect(LONG_RAIL_PARTS).toBe(2);
    expect(wire(5.9 * piece)).toBeNull();
    expect(wire(6.1 * piece)).toBe("lunghezza");
    expect(wire(1.9 * piece, true)).toBeNull();
    expect(wire(2.1 * piece, true)).toBe("alimentazione");
  });

  it("a wire between two sections, or straying out of its own, is cut", () => {
    expect(wire(1, false, ["a", "b"])).toBe("sezione");
    expect(wire(1, false, ["a", "a"])).toBeNull();
    expect(wire(1, false, ["a", "a"], [{ x: 3, y: 0.5 }])).toBe("sezione");
    expect(wire(1, false, ["a", null], [{ x: 2.2, y: 0.5 }])).toBeNull();
  });

  it("the typical part is the median, bounded", () => {
    expect(pieceSize([{ width: 0.6, height: 0.65 }, { width: 0.6, height: 0.65 }, { width: 2, height: 8 }])).toBe(0.65);
    expect(pieceSize([])).toBe(0.65);
    expect(pieceSize([{ width: 0.05, height: 0.05 }])).toBe(0.4);
  });

  it("junction dots where three or more conductors meet, not at corners", () => {
    const p = (x: number, y: number) => ({ x, y });
    // a T: the stem ends in the middle of the bar
    expect(findJunctions([{ segments: [[p(0, 0), p(2, 0)], [p(1, 0), p(1, 1)]], pins: [] }])).toEqual([p(1, 0)]);
    // a corner of one wire, and a pin with a single wire: no dot
    expect(findJunctions([{ segments: [[p(0, 0), p(1, 0)], [p(1, 0), p(1, 1)]], pins: [p(0, 0)] }])).toEqual([]);
    // a pin with two wires
    expect(findJunctions([{ segments: [[p(0, 0), p(1, 0)], [p(0, 0), p(0, 1)]], pins: [p(0, 0)] }])).toEqual([p(0, 0)]);
    expect(wireEnds([[p(0, 0), p(1, 0)], [p(1, 0), p(1, 1)]]).map((e) => e.at)).toEqual([p(0, 0), p(1, 1)]);
  });

  it("on the sheet: the long signal becomes a flag at each pin, the rail a symbol, the short wire stays", () => {
    const model = buildSchematicModel(row());
    expect(model.wires.map((w) => w.id)).toEqual(["t_short"]);
    expect(model.labeledWires.map((w) => [w.id, w.reason])).toEqual([
      ["t_long", "lunghezza"],
      ["t_gnd", "alimentazione"],
    ]);
    const sig = model.netLabels.filter((l) => l.forWire === "t_long");
    expect(sig.map((l) => [l.shape, l.text, l.net])).toEqual([
      ["flag", "SIG", "SIG"],
      ["flag", "SIG", "SIG"],
    ]);
    const ends = sig.map((l) => [l.attach.x, l.attach.y]).sort((a, b) => a[0] - b[0]);
    expect(ends[0][0]).toBeCloseTo(0.3);
    expect(ends[1][0]).toBeCloseTo(9.7);
    // each flag grows away from its resistor, the way the wire left
    const right = sig.find((l) => l.attach.x > 5)!;
    expect(right.box.maxX).toBeLessThanOrEqual(9.7 + 1e-6);
    const gnd = model.netLabels.filter((l) => l.forWire === "t_gnd");
    expect(gnd.map((l) => l.shape)).toEqual(["ground", "ground"]);
    expect(gnd.every((l) => l.ground && l.power)).toBe(true);
  });

  it("the name shown comes from reti, the connectivity stays the circuit's", () => {
    const model = buildSchematicModel(row(), notes({ reti: { SIG: "U10.VBAT" } }));
    const sig = model.netLabels.filter((l) => l.forWire === "t_long");
    expect(sig.map((l) => [l.text, l.net])).toEqual([
      ["U10.VBAT", "SIG"],
      ["U10.VBAT", "SIG"],
    ]);
    expect(model.netLabelNames).toEqual({ SIG: "U10.VBAT" });
  });

  it("a short wire between two sections is cut too", () => {
    const model = buildSchematicModel(row(), notes({ sezioni: [{ nome: "a", pezzi: ["R1"] }, { nome: "b", pezzi: ["R3", "R2", "R4"] }] }));
    expect(model.labeledWires.find((w) => w.id === "t_short")?.reason).toBe("sezione");
    expect(model.wires).toHaveLength(0);
  });
});

describe("sections and comments from the file", () => {
  const inside = (outer: { x: number; y: number; w: number; h: number }, b: Box) =>
    b.minX >= outer.x && b.maxX <= outer.x + outer.w && b.minY >= outer.y && b.maxY <= outer.y + outer.h;

  it("one frame per section around its parts, titled, apart from each other", () => {
    const model = buildSchematicModel(
      row(),
      notes({
        sezioni: [
          { nome: "ingresso", titolo: "Ingresso", pezzi: ["R1", "R3", "R4"] },
          { nome: "uscita", titolo: "Uscita", pezzi: ["R2"] },
        ],
      }),
    );
    expect(model.sectionFrames.map((f) => f.name).sort()).toEqual(["ingresso", "uscita"]);
    for (const f of model.sectionFrames) {
      for (const name of f.pieces ?? []) expect(inside(f, model.nodes.find((n) => n.name === name)!.bbox)).toBe(true);
    }
    expect(model.sectionOverlaps).toEqual([]);
    expect(model.sectionTitles.map((t) => t.text).sort()).toEqual(["Ingresso", "Uscita"]);
  });

  it("overlapping frames are reported, the larger one drawn dashed under the other", () => {
    const model = buildSchematicModel(
      row(),
      notes({ sezioni: [{ nome: "sparsa", pezzi: ["R1", "R2"] }, { nome: "centro", pezzi: ["R3"] }] }),
    );
    expect(model.sectionOverlaps).toEqual([["sparsa", "centro"]]);
    const sparsa = model.sectionFrames.find((f) => f.name === "sparsa")!;
    const centro = model.sectionFrames.find((f) => f.name === "centro")!;
    expect(sparsa.dashed).toBe(true);
    expect(centro.dashed).toBeUndefined();
    expect(model.sectionFrames.indexOf(sparsa)).toBeLessThan(model.sectionFrames.indexOf(centro));
    expect(model.noteWarnings.join(" ")).toMatch(/cornici sovrapposte: sparsa \/ centro/);
  });

  it("parts the sheet does not have are said, not drawn", () => {
    const model = buildSchematicModel(row(), notes({ sezioni: [{ nome: "x", pezzi: ["U99"] }], commenti: { U98: "?" } }));
    expect(model.sectionFrames).toEqual([]);
    expect(model.noteWarnings.join(" | ")).toMatch(/U99/);
    expect(model.noteWarnings.join(" | ")).toMatch(/U98/);
  });

  it("the comment is a small line under the value, cut with an ellipsis, never on a pin or a wire", () => {
    const long = "un commento molto lungo che non puo' stare tutto sotto una resistenza piccola";
    const model = buildSchematicModel(row(), notes({ commenti: { R1: long, R2: "corto" } }));
    const r1 = model.nodes.find((n) => n.name === "R1")!;
    const c1 = r1.labels.find((l) => l.tone === "comment")!;
    expect(c1.text.endsWith("…")).toBe(true);
    expect(c1.full).toBe(long);
    const value = r1.labels.find((l) => l.tone === "value")!;
    expect(textBox(c1).minY).toBeGreaterThanOrEqual(textBox(value).maxY - 1e-6);
    const r2 = model.nodes.find((n) => n.name === "R2")!;
    expect(r2.labels.find((l) => l.tone === "comment")?.text).toBe("corto");
    assertCommentsClear(model);
  });

  it("without the file nothing changes: no frames, no comments", () => {
    const model = buildSchematicModel(row());
    expect(model.sectionFrames).toEqual([]);
    expect(model.nodes.flatMap((n) => n.labels).some((l) => l.tone === "comment")).toBe(false);
    expect(model.noteWarnings).toEqual([]);
  });
});

/** no comment box may cover a pin line, a wire, another part or a net label */
function assertCommentsClear(model: SchematicModel) {
  const wires: Box[] = [];
  for (const w of model.wires) {
    const nums = w.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    for (let i = 0; i + 3 < nums.length; i += 4) {
      wires.push({
        minX: Math.min(nums[i], nums[i + 2]),
        maxX: Math.max(nums[i], nums[i + 2]),
        minY: Math.min(nums[i + 1], nums[i + 3]),
        maxY: Math.max(nums[i + 1], nums[i + 3]),
      });
    }
  }
  for (const node of model.nodes) {
    for (const c of node.labels.filter((l) => l.tone === "comment" && !l.fixed)) {
      const b = textBox(c);
      for (const w of wires) expect(overlaps(b, w, 0.005)).toBe(false);
      for (const l of model.netLabels) expect(overlaps(b, l.box, 0.005)).toBe(false);
      for (const other of model.nodes) if (other !== node) expect(overlaps(b, other.bbox, 0.005)).toBe(false);
    }
  }
}

describe("sheet drawing", () => {
  it("titles, comments and net names from the file are drawn as text, never as markup", () => {
    const svg = renderSchematicSvg(row(), {
      width: 900,
      height: 500,
      notes: JSON.stringify({
        sezioni: [{ nome: "a", titolo: "<img src=x onerror=alert(1)>", pezzi: ["R1", "R3"] }],
        commenti: { R1: "<script>alert(1)</script>" },
        reti: { SIG: "<b>grassetto</b>" },
      }),
    });
    expect(svg).not.toContain("<img");
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;img src=x");
    expect(svg).toContain("&lt;b&gt;grassetto&lt;/b&gt;");
  });

  it("a broken schematico.json leaves the sheet drawn, with the reason on it", () => {
    const model = buildSchematicModel(withSchematicNotes(row(), "{not json"));
    expect(model.noteWarnings[0]).toMatch(/non e' un JSON valido/);
    expect(model.nodes).toHaveLength(4);
    const svg = renderSchematicSvg(model, { width: 600, height: 400 });
    expect(svg).toContain("non e&#x27; un JSON valido");
  });

  it("zoomed out, pin names, pin numbers and comments go; designators stay", () => {
    const pin = { tone: "pin" as const, size: 0.12 };
    expect(showsLabel(pin, 20)).toBe(false);
    expect(showsLabel(pin, 60)).toBe(true);
    expect(showsLabel({ tone: "comment", size: 0.1 }, 40)).toBe(false);
    expect(showsLabel({ tone: "name", size: 0.15 }, 1)).toBe(true);
    const near = renderSchematicSvg(row(), { width: 1600, height: 800, notes: '{"commenti": {"R1": "nota"}}' });
    const far = renderSchematicSvg(row(), { width: 160, height: 80, notes: '{"commenti": {"R1": "nota"}}' });
    expect(near).toContain(">nota<");
    expect(far).not.toContain(">nota<");
    expect(far).toContain(">R1<");
  });

  /*
   * WCAG contrast: text at least 4.5:1 against the sheet, wires and part
   * outlines at least 3:1, on the dark and on the light sheet. Pin names sit
   * on the IC body, the titles on the frame fill: those pairs are checked too.
   */
  it("every class of net and every text stays readable on both sheets", () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const [theme, c] of Object.entries(SHEET_PALETTES)) {
      for (const text of [c.name, c.value, c.pin, c.number, c.comment, c.label, c.title, c.faint, c.warning, c.power, c.ground]) {
        expect(contrast(text, c.sheet), `${theme} ${text}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const stroke of [c.wire, c.power, c.ground, c.outline, c.selected]) {
        expect(contrast(stroke, c.sheet), `${theme} ${stroke}`).toBeGreaterThanOrEqual(3);
      }
      for (const text of [c.pin, c.name, c.value]) expect(contrast(text, c.body), `${theme} body`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.title, c.frameFill), `${theme} title`).toBeGreaterThanOrEqual(4.5);
      // the three classes must not be mistaken for one another
      expect(new Set([c.wire, c.power, c.ground, c.selected]).size).toBe(4);
    }
  });
});
