import { deflateSync } from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { eseguiLimitato, importAltiumLibrary } from "@/lib/altium-import";
import {
  contornoNativo,
  footprintDaNativo,
  formaDelPad,
  leggiStrati,
  MIL,
  nomeDaRecordPad,
  nomiDeiPadDiLibreria,
  StratiNonSupportati,
  stratiPredefiniti,
} from "@/lib/altium-layers";
import { modelli3dNativi, LIMITI_3D } from "@/lib/altium-3d";

/** a raw Altium pad record whose name block says `nome` */
function recordPad(nome: string): string {
  const testo = Buffer.from(nome, "latin1");
  const blocco = Buffer.alloc(1 + testo.length);
  blocco.writeUInt8(testo.length, 0);
  testo.copy(blocco, 1);
  const testa = Buffer.alloc(5);
  testa.writeUInt8(2, 0);
  testa.writeUInt32LE(blocco.length, 1);
  return Buffer.concat([testa, blocco, Buffer.alloc(16)]).toString("base64");
}

describe("copper layers", () => {
  const stack = (nomi: string[]) =>
    nomi.map((name, i) => ({ name, legacyLayerId: i === nomi.length - 1 ? 32 : i + 1 }));

  it("a four layer board is top, inner1, inner2, bottom", () => {
    const strati = leggiStrati({ layers: stack(["TOP", "GND", "PWR", "BOTTOM"]) });
    expect([...strati.values()].map((s) => s.faccia)).toEqual(["top", "inner1", "inner2", "bottom"]);
  });

  it("refuses a board with more than two inner layers in use, instead of shorting them", () => {
    const pcb = {
      layers: stack(["TOP", "IN1", "IN2", "IN3", "IN4", "BOTTOM"]),
      tracks: [2, 3, 4].map((layerId) => ({ layerId, x1: 0, y1: 0, x2: 10, y2: 0, netIndex: 1 })),
    };
    expect(() => leggiStrati(pcb)).toThrow(StratiNonSupportati);
    expect(() => leggiStrati(pcb)).toThrow(/6 strati di rame e 3 strati interni usati/);
  });

  it("an internal plane counts as used even with nothing drawn on it", () => {
    const pcb = {
      layers: [
        { name: "TOP", legacyLayerId: 1 },
        { name: "MID1", legacyLayerId: 2 },
        { name: "InternalPlane1", legacyLayerId: 39 },
        { name: "InternalPlane2", legacyLayerId: 40 },
        { name: "MID4", legacyLayerId: 5 },
        { name: "BOTTOM", legacyLayerId: 32 },
      ],
      tracks: [{ layerId: 2, x1: 0, y1: 0, x2: 1, y2: 0 }],
    };
    expect(() => leggiStrati(pcb)).toThrow(StratiNonSupportati);
  });

  it("keeps a six layer stack with two empty inner layers, and says so", () => {
    const avvisi: string[] = [];
    const strati = leggiStrati(
      {
        layers: stack(["TOP", "IN1", "IN2", "IN3", "IN4", "BOTTOM"]),
        tracks: [{ layerId: 3, x1: 0, y1: 0, x2: 1, y2: 0 }],
        vias: [{ layerStartId: 1, layerEndId: 5, x: 0, y: 0 }],
      },
      avvisi,
    );
    const facce = new Map([...strati].filter(([, s]) => s.genere === "rame").map(([id, s]) => [id, s.faccia]));
    expect(facce).toEqual(new Map([[1, "top"], [3, "inner1"], [5, "inner2"], [32, "bottom"]]));
    expect(avvisi.join(" ")).toMatch(/IN1, IN3/);
  });
});

describe("pad names", () => {
  it("reads the name at the head of a pad record", () => {
    expect(nomeDaRecordPad(recordPad("A12"))).toBe("A12");
    expect(nomeDaRecordPad(recordPad("x\u0001y"))).toBe("xy");
    expect(nomeDaRecordPad("")).toBe("");
    expect(nomeDaRecordPad(Buffer.from([3, 0, 0, 0, 0, 0, 0]).toString("base64"))).toBe("");
  });

  it("library pads take their names only when the records line up one to one", () => {
    const fp = {
      pads: [{}, {}],
      rawRecords: [
        { parsed: true, family: "pads", rawBase64: recordPad("1") },
        { parsed: true, family: "tracks", rawBase64: "AAAA" },
        { parsed: true, family: "pads", rawBase64: recordPad("SH") },
      ],
    };
    expect(nomiDeiPadDiLibreria(fp)).toEqual(["1", "SH"]);
    expect(nomiDeiPadDiLibreria({ ...fp, pads: [{}] })).toBeNull();
    expect(
      nomiDeiPadDiLibreria({ pads: [{}], rawRecords: [{ parsed: true, family: "pads", rawBase64: "" }] }),
    ).toBeNull();
  });

  it("a library footprint with unreadable names is numbered and marked unverified", () => {
    const pad = { x: 0, y: 0, sizeTopX: 20, sizeTopY: 20, shapeTopName: "rectangular", layerId: 1 };
    const letto = footprintDaNativo({ pads: [pad, { ...pad, x: 50 }] }, stratiPredefiniti());
    expect(letto.nomiVerificati).toBe(false);
    expect(letto.elementi.map((e) => (e.port_hints as string[])[0])).toEqual(["1", "2"]);
    const conNomi = footprintDaNativo(
      {
        pads: [pad, { ...pad, x: 50 }],
        rawRecords: [
          { parsed: true, family: "pads", rawBase64: recordPad("2") },
          { parsed: true, family: "pads", rawBase64: recordPad("1") },
        ],
      },
      stratiPredefiniti(),
    );
    expect(conNomi.nomiVerificati).toBe(true);
    expect(conNomi.elementi.map((e) => (e.port_hints as string[])[0])).toEqual(["2", "1"]);
  });
});

describe("pad shapes from the native record", () => {
  const mm = (v: number) => v / MIL;

  it("an obround SMD pad is a pill, not a disc as wide as its long side", () => {
    expect(formaDelPad({ sizeTopX: mm(1.5), sizeTopY: mm(0.3), shapeTopName: "round", rotation: 90 })?.campi).toMatchObject({
      shape: "pill",
      width: 1.5,
      height: 0.3,
      radius: 0.15,
      ccw_rotation: 90,
    });
  });

  it("a rounded rectangle is a rectangle with its corner", () => {
    expect(
      formaDelPad({ sizeTopX: mm(1.5), sizeTopY: mm(0.3), shapeTopName: "rounded-rectangle", hasRoundedRect: true, cornerRadiusTop: 50 })?.campi,
    ).toMatchObject({ shape: "rect", width: 1.5, height: 0.3, rect_border_radius: 0.15 });
  });

  it("a slot in an oval pad, along the pad or across it", () => {
    const base = { sizeTopX: mm(1), sizeTopY: mm(2.2), shapeTopName: "round", holeDiameter: mm(0.6), holeShape: 2, holeSlotLength: mm(1.6) };
    expect(formaDelPad({ ...base, holeRotation: 90 })?.campi).toMatchObject({
      shape: "pill",
      outer_width: 1,
      outer_height: 2.2,
      hole_width: 0.6,
      hole_height: 1.6,
    });
    expect(formaDelPad({ ...base, holeRotation: 0 })?.campi).toMatchObject({ hole_width: 1.6, hole_height: 0.6 });
    const obliqua = formaDelPad({ ...base, holeRotation: 30 });
    expect(obliqua?.campi).toMatchObject({ hole_width: 0.6, hole_height: 0.6 });
    expect(obliqua?.avviso).toMatch(/asola ruotata/);
  });

  it("a slot in a rectangular pad, and a round hole in one", () => {
    expect(
      formaDelPad({ sizeTopX: mm(1), sizeTopY: mm(2), shapeTopName: "rectangular", holeDiameter: mm(0.5), holeShape: 2, holeSlotLength: mm(1.2), holeRotation: 90 })?.campi,
    ).toMatchObject({ shape: "pill_hole_with_rect_pad", hole_width: 0.5, hole_height: 1.2, rect_pad_width: 1, rect_pad_height: 2 });
    expect(
      formaDelPad({ sizeTopX: mm(1.7), sizeTopY: mm(1.7), shapeTopName: "rectangular", holeDiameter: mm(1) })?.campi,
    ).toMatchObject({ shape: "circular_hole_with_rect_pad", hole_diameter: 1, rect_pad_width: 1.7 });
  });

  it("a round pad with a round hole stays a circle", () => {
    expect(formaDelPad({ sizeTopX: mm(1.6), sizeTopY: mm(1.6), shapeTopName: "round", holeDiameter: mm(0.8) })?.campi).toEqual({
      shape: "circle",
      outer_diameter: 1.6,
      hole_diameter: 0.8,
    });
  });

  it("nothing to say for an unknown shape or a pad with no size", () => {
    expect(formaDelPad({ sizeTopX: 0, sizeTopY: 10, shapeTopName: "round" })).toBeNull();
    expect(formaDelPad({ sizeTopX: 10, sizeTopY: 10, shapeTopName: "custom" })).toBeNull();
  });
});

describe("board outline from the native model", () => {
  const t = (x: number, y: number) => ({ x: x * MIL, y: y * MIL });

  it("follows an arc instead of cutting across it", () => {
    const punti = contornoNativo(
      {
        boardOutline: {
          segments: [
            { type: "line", x1: 0, y1: -1000, x2: 1000, y2: -1000 },
            { type: "arc", x1: 1000, y1: -1000, x2: 1000, y2: 1000, cx: 1000, cy: 0, radius: 1000, startAngle: 270, endAngle: 90 },
            { type: "line", x1: 1000, y1: 1000, x2: 0, y2: 1000 },
          ],
        },
      },
      t,
    );
    expect(punti.length).toBeGreaterThan(10);
    // every point of the arc is on its circle, on the right of the centre
    for (const p of punti.slice(2, -1)) {
      expect(Math.hypot(p.x - 25.4, p.y)).toBeCloseTo(25.4, 2);
      expect(p.x).toBeGreaterThan(25.4);
    }
  });

  it("a round board is a whole circle", () => {
    const punti = contornoNativo(
      {
        boardOutline: {
          segments: [{ type: "arc", x1: 1000, y1: 0, x2: 1000, y2: 0, cx: 0, cy: 0, radius: 1000, startAngle: 0, endAngle: 360 }],
        },
      },
      t,
    );
    expect(punti.length).toBe(36);
  });
});

describe("the isolated reader", () => {
  const corpoInflate = `
const { unzlibSync } = await import("fflate");
return unzlibSync(new Uint8Array(workerData.dati.compresso)).length;
`;

  it("refuses a decompression bomb", async () => {
    const bomba = deflateSync(Buffer.alloc(64 * 1024 * 1024));
    expect(bomba.length).toBeLessThan(200 * 1024);
    const esito = await eseguiLimitato<number>(
      corpoInflate,
      { compresso: bomba.buffer.slice(bomba.byteOffset, bomba.byteOffset + bomba.byteLength) },
      { tempoMs: 30_000, heapMb: 256, bufferMb: 16 },
    );
    expect(esito.ok).toBe(false);
    expect(esito.ok === false && esito.superato).toBe(true);
  });

  it("reads what fits", async () => {
    const piccolo = deflateSync(Buffer.alloc(1024 * 1024, 7));
    const esito = await eseguiLimitato<number>(
      corpoInflate,
      { compresso: piccolo.buffer.slice(piccolo.byteOffset, piccolo.byteOffset + piccolo.byteLength) },
      { tempoMs: 30_000, heapMb: 256, bufferMb: 16 },
    );
    expect(esito).toEqual({ ok: true, valore: 1024 * 1024 });
  });

  it("stops a read that does not end", async () => {
    const esito = await eseguiLimitato("for (;;) {}", {}, { tempoMs: 300, heapMb: 64, bufferMb: 8 });
    expect(esito.ok).toBe(false);
    expect(esito.ok === false && esito.errore).toMatch(/interrotta/);
  });

  it("an unreadable file is a warning, not a crash, and goes through the worker", async () => {
    const { components, warnings } = await importAltiumLibrary({
      path: "rotto.PcbLib",
      data: new Uint8Array([1, 2, 3, 4]).buffer,
    });
    expect(components).toEqual([]);
    expect(warnings[0]).toMatch(/^rotto\.PcbLib: /);
    expect(warnings.join("\n")).not.toMatch(/senza i limiti/);
  });

  it("imports a real .PcbLib through the worker, pads numbered and marked unverified", async () => {
    // the toolkit's own exporter, to have a valid OLE file without shipping one
    const percorso = path.join(
      process.cwd(),
      "node_modules/altium-toolkit/src/core/altium/AltiumPcbLibExporter.mjs",
    );
    const { AltiumPcbLibExporter } = (await import(pathToFileURL(percorso).href)) as {
      AltiumPcbLibExporter: { export: (b: unknown) => Uint8Array };
    };
    const byte = AltiumPcbLibExporter.export({
      name: 'Pericolo" /> */',
      footprint: {
        name: 'FP\n"x"',
        pads: [
          { x: 0, y: 0, width: 60, height: 120, holeDiameter: 30, shapeTopName: "round", layerId: 74 },
          { x: 100, y: 0, width: 40, height: 40, shapeTopName: "rectangular", layerId: 1 },
        ],
      },
    });
    const { components, warnings } = await importAltiumLibrary({
      path: 'lib "x".PcbLib',
      data: byte.buffer.slice(byte.byteOffset, byte.byteOffset + byte.byteLength) as ArrayBuffer,
    });
    expect(warnings.join("\n")).not.toMatch(/senza i limiti/);
    expect(components.length).toBe(1);
    const c = components[0];
    expect(c.pads).toBe(2);
    expect(c.piedinaturaVerificata).toBe(false);
    expect(c.code).toContain("PIEDINATURA NON VERIFICATA");
    // the obround through-hole pad is a pill, not a disc
    expect(c.code).toMatch(/<platedhole shape="pill" outerWidth=\{1\.524\} outerHeight=\{3\.048\}/);
    // the file name went into a comment and stayed there
    expect(c.code.split("\n")[0]).toMatch(/^\/\/ Importato da Altium: lib "x"\.PcbLib/);
  });
});

describe("3D models within limits", () => {
  it("a STEP over the size limit is not tessellated, and the part keeps a box", async () => {
    const pcb = {
      components: [{ designator: "J1", rotation: 0, height: 200 }],
      componentPrimitiveGroups: [
        { designator: "J1", pads: [{ x: 0, y: 0, sizeTopX: 40, sizeTopY: 40 }, { x: 100, y: 0, sizeTopX: 40, sizeTopY: 40 }] },
      ],
      componentBodies: [{ positionMil: { x: 50, y: 0 }, modelId: "m1", overallHeightMil: 200, modelRotationDeg: { x: 0, y: 0, z: 0 } }],
      embeddedModels: [{ id: "m1", format: "step", payloadText: "ISO-10303-21;".repeat(100) }],
    };
    const out = await modelli3dNativi(pcb, { ...LIMITI_3D, stepByte: 100 });
    expect(out.modelli).toEqual([]);
    expect(out.warnings.join("\n")).toMatch(/oltre il limite/);
    expect(out.corpi.find((c) => c.designator === "J1")?.scatola).toBeTruthy();
  });
});
