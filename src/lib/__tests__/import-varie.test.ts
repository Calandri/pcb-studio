import { describe, expect, it } from "vitest";
import { codiceLcsc, sceltaLcsc } from "@/lib/altium-datasheets";
import { gltfInMillimetri } from "@/lib/cad-import";
import { ENCLOSURE_NAME_RE, enclosureNameFrom } from "@/lib/enclosure-store";
import { meshesToStl, stlSolidName } from "@/lib/stl-export";

describe("LCSC order codes", () => {
  it("only a positive integer becomes a code", () => {
    expect(codiceLcsc(25744)).toBe("C25744");
    expect(codiceLcsc("C25744")).toBe("C25744");
    expect(codiceLcsc('1"] }} /><x')).toBeNull();
    expect(codiceLcsc("${x}")).toBeNull();
    expect(codiceLcsc(-3)).toBeNull();
    expect(codiceLcsc(1.5)).toBeNull();
    expect(codiceLcsc(0)).toBeNull();
    expect(codiceLcsc(undefined)).toBeNull();
  });

  it("the same part is the same code, ignoring punctuation and case", () => {
    expect(sceltaLcsc("SPH0641LU4H-1", [{ lcsc: 9, mfr: "sph0641lu4h1" }])).toEqual({
      codice: "C9",
      mfr: "sph0641lu4h1",
      approssimato: false,
    });
  });

  it("a relative is approximate, and an exact match wins over it", () => {
    expect(sceltaLcsc("LM358", [{ lcsc: 1, mfr: "LM358D" }])).toMatchObject({ approssimato: true });
    expect(
      sceltaLcsc("ABS07-120-32.768KHZ-T", [
        { lcsc: 1, mfr: "ABS07-32.768KHZ-T" },
        { lcsc: 2, mfr: "ABS07-120-32.768KHZ-T" },
      ]),
    ).toMatchObject({ codice: "C2", approssimato: false });
    expect(sceltaLcsc("LM358", [{ lcsc: 1, mfr: "LM358D" }, { lcsc: 2, mfr: "LM358" }])).toMatchObject({
      codice: "C2",
      approssimato: false,
    });
  });

  it("no code from a result with a hostile or missing code", () => {
    expect(sceltaLcsc("LM358", [{ lcsc: '1"]', mfr: "LM358" }])).toBeNull();
    expect(sceltaLcsc("LM358", [{ mfr: "LM358" }])).toBeNull();
    expect(sceltaLcsc("", [{ lcsc: 1, mfr: "" }])).toBeNull();
  });
});

describe("STL", () => {
  it("the solid name cannot add lines to the file", () => {
    expect(stlSolidName("scocca\nfacet normal 0 0 1")).toBe("scocca_facet_normal_0_0_1");
    expect(stlSolidName("  ")).toBe("solid");
    const stl = meshesToStl([{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }], "a\r\nendsolid x y");
    expect(stl.split("\n")[0]).toBe("solid a_endsolid_x_y");
    expect(stl.split("\n").filter((l) => l.startsWith("endsolid")).length).toBe(1);
  });
});

describe("enclosure names", () => {
  it("a file name becomes a name the store accepts", () => {
    for (const nome of ["scocca (1)", "coperchio più alto", "../../etc", "", "   ", "a".repeat(200), "x y", "€€€"]) {
      expect(ENCLOSURE_NAME_RE.test(enclosureNameFrom(nome))).toBe(true);
    }
    expect(enclosureNameFrom("coperchio più alto")).toBe("coperchio piu alto");
    expect(enclosureNameFrom("")).toBe("modello");
  });
});

describe("glTF units", () => {
  it("metres and Y up become millimetres and Z up", () => {
    const m = gltfInMillimetri({ positions: [0, 0, 0, 0.08, 0, 0, 0, 0.02, 0], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0] });
    expect(m.positions).toEqual([0, 0, 0, 80, 0, 0, 0, 0, 20]);
    expect(m.normals?.slice(0, 3)).toEqual([0, 0, 1]);
  });

  it("a file already in millimetres is only turned", () => {
    const m = gltfInMillimetri({ positions: [0, 0, 0, 80, 0, 0, 0, 20, 0] });
    expect(m.positions.slice(3, 6)).toEqual([80, 0, 0]);
    expect(m.positions.slice(6, 9)).toEqual([0, 0, 20]);
  });
});
