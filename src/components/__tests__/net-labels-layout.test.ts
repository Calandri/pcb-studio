import { describe, expect, it } from "vitest";
import { latoDi, layoutNetLabels, type NetLabelInput, type PlacedNetLabel } from "../board/net-labels";

/*
 * R6 di sbb-dl-retro (0402, pad a mezzo millimetro): "GNSS_PWRCTL" a sinistra e
 * "CTL_SRC" a destra si leggevano "GNSS_PWRCTLCTL_SRC". E i pin di un QFN, tutti
 * sullo stesso lato a 0,5 mm: nessun nome sopra un altro, a nessuno zoom.
 */
const lab = (key: string, x: number, y: number, lato: NetLabelInput["lato"], testo: string, sotto = ""): NetLabelInput => ({
  key, x, y, lato, raggio: 0.25, testo, sotto, colore: "#fff",
});
const siToccano = (a: PlacedNetLabel, b: PlacedNetLabel) =>
  a.bx < b.bx + b.bw && b.bx < a.bx + a.bw && a.by < b.by + b.bh && b.by < a.by + a.bh;
const nessunaSovrapposizione = (ls: PlacedNetLabel[]) => {
  for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) expect(siToccano(ls[i], ls[j]), `${ls[i].key}/${ls[j].key}`).toBe(false);
};

describe("i nomi delle reti non si sovrappongono", () => {
  it("il lato si legge dalla posizione del pad rispetto al pezzo", () => {
    expect(latoDi(-0.5, 0)).toBe("left");
    expect(latoDi(0.5, 0.1)).toBe("right");
    expect(latoDi(0, 0.7)).toBe("up");
    expect(latoDi(0.1, -0.7)).toBe("down");
  });

  for (const k of [5, 20, 80]) {
    it(`R6 a ${k} px/mm: ognuno dal suo lato, spinto in fuori`, () => {
      const [sx, dx] = layoutNetLabels(
        [lab("a", -0.25, 0, "left", "GNSS_PWRCTL", "R6.2"), lab("b", 0.25, 0, "right", "CTL_SRC", "R6.1")],
        { x: 400, y: 300, k },
      );
      expect(sx.bx + sx.bw).toBeLessThanOrEqual(sx.ax);
      expect(dx.bx).toBeGreaterThanOrEqual(dx.ax);
      expect(siToccano(sx, dx)).toBe(false);
      expect(sx.leader || dx.leader).toBe(false);
    });

    it(`16 pin di un QFN sullo stesso lato a ${k} px/mm: nessuna sovrapposizione`, () => {
      const ls = Array.from({ length: 16 }, (_, i) => lab(`q${i}`, -3.75 + i * 0.5, 2, "up", `NET_LUNGA_${i}`, `U2.${i + 1}`));
      nessunaSovrapposizione(layoutNetLabels(ls, { x: 400, y: 300, k }));
    });
  }

  it("un modulo coi pin su quattro lati: nessuna sovrapposizione, chi si sposta ha la linea", () => {
    const ls: NetLabelInput[] = [];
    for (let i = 0; i < 10; i++) {
      ls.push(lab(`l${i}`, -5, -2.5 + i * 0.5, "left", `SINISTRA_${i}`, `U2.${i}`));
      ls.push(lab(`r${i}`, 5, -2.5 + i * 0.5, "right", `DESTRA_${i}`, `U2.${i + 10}`));
      ls.push(lab(`u${i}`, -2.5 + i * 0.5, 5, "up", `SOPRA_${i}`, `U2.${i + 20}`));
      ls.push(lab(`d${i}`, -2.5 + i * 0.5, -5, "down", `SOTTO_${i}`, `U2.${i + 30}`));
    }
    const out = layoutNetLabels(ls, { x: 400, y: 300, k: 12 });
    nessunaSovrapposizione(out);
    expect(out.some((l) => l.leader)).toBe(true);
  });

  it("i nomi non si accorciano mai", () => {
    const [l] = layoutNetLabels([lab("a", 0, 0, "up", "UN_NOME_DI_RETE_MOLTO_MOLTO_LUNGO")], { x: 0, y: 0, k: 10 });
    expect(l.testo).toBe("UN_NOME_DI_RETE_MOLTO_MOLTO_LUNGO");
    expect(l.bw).toBeGreaterThan("UN_NOME_DI_RETE_MOLTO_MOLTO_LUNGO".length * 6);
  });
});
