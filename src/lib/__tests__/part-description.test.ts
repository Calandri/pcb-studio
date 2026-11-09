import { describe, expect, it } from "vitest";
import { cleanDescription, mpnTokens } from "@/lib/component-descriptions";
import { descriviPezzo } from "@/lib/part-description";

/*
 * U2 di sbb-dl-retro: un SIMCom SIM7672G-MNGV / A7672E-FASE dichiarato in
 * manufacturerPartNumber, descritto dal modello come "tipo Quectel BG95"
 * (2026-11-09). E la card metteva la descrizione generata davanti a quella
 * scritta nel .tsx.
 */
const base = { name: "U2", description: null, tags: null, role: "chip", why: null, mpn: "SIM7672G-MNGV / A7672E-FASE", value: null };

describe("descrizione generata: si parte dal part dichiarato", () => {
  it("le parole del codice da cercare nei datasheet", () => {
    expect(mpnTokens("SIM7672G-MNGV / A7672E-FASE")).toEqual(expect.arrayContaining(["SIM7672G", "A7672E", "SIM7672G-MNGV", "A7672E-FASE"]));
    expect(mpnTokens(null)).toEqual([]);
  });

  it("toglie il 'tipo X' e nomina il part dichiarato", () => {
    const d = cleanDescription("Modulo cellulare LTE-M/NB-IoT + GNSS integrato (tipo Quectel BG95)", "Modem (simile a BG95) della scheda.", "SIM7672G-MNGV / A7672E-FASE");
    expect(d.role).not.toMatch(/BG95|tipo/);
    expect(d.role).toMatch(/^SIM7672G-MNGV \/ A7672E-FASE: /);
    expect(d.why).not.toMatch(/BG95/);
    expect(cleanDescription("Modem LTE Cat 1 SIM7672G", "x", "SIM7672G-MNGV").role).toBe("Modem LTE Cat 1 SIM7672G");
  });
});

describe("la card: da dove viene il testo", () => {
  it("la descrizione scritta nel progetto vince su quella generata", () => {
    const d = descriviPezzo({ ...base, description: "Modem LTE Cat 1 SIMCom, eSIM MFF2 saldata", generated: { role: "tipo BG95", why: "connettore SIM" } });
    expect(d.fonte).toBe("progetto");
    expect(d.testo).toBe("Modem LTE Cat 1 SIMCom, eSIM MFF2 saldata");
    expect(`${d.titolo} ${d.testo}`).not.toMatch(/BG95|connettore SIM/);
  });

  it("senza descrizione scritta: quella generata, detta tale", () => {
    expect(descriviPezzo({ ...base, generated: { role: "Modem SIM7672G", why: "..." } }).fonte).toBe("datasheet");
  });

  it("mai 'chip' da solo: il codice produttore, o 'senza descrizione'", () => {
    const d = descriviPezzo(base);
    expect(d.titolo).toBe("SIM7672G-MNGV / A7672E-FASE");
    expect(descriviPezzo({ ...base, mpn: null }).titolo).toBe("senza descrizione nel progetto");
    expect(descriviPezzo({ ...base, role: "chip — alimentato da P3V3", why: "x" }).titolo).toBe("SIM7672G-MNGV / A7672E-FASE — alimentato da P3V3");
  });
});
