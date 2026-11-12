import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * sbb-dl-principale, 12/11/2026: la scheda salvata alle 12:02:14 aveva 7 piste
 * e 7 vie della scheda di prima accanto a quelle dei file, ognuna con l'id di
 * una nuova (pcb_trace_0, _1, _3, _4, _17, _18, _85), e niente lo diceva. Una
 * scheda con un id doppio si salva (e' la scheda che c'e'), ma non in silenzio:
 * lo dice il messaggio del riepilogo salvato con lei e una riga di errore nel
 * registro della funzione.
 */

/** le query che arrivano al database finto: il testo e i valori */
const query = vi.hoisted(() => ({ fatte: [] as Array<{ testo: string; valori: unknown[] }> }));
vi.mock("@neondatabase/serverless", () => ({
  neon: () => (strings: TemplateStringsArray, ...valori: unknown[]) => {
    query.fatte.push({ testo: strings.join("?"), valori });
    return Promise.resolve([]);
  },
}));

import { AVVISO_ID_DOPPI, avvisaDegliIdDoppi, idDoppi } from "@/lib/duplicate-ids";
import { saveCompileCache } from "@/lib/project-store";

const pista = (id: string, x: number) => ({
  type: "pcb_trace",
  pcb_trace_id: id,
  source_trace_id: "source_trace_0",
  route: [
    { route_type: "wire", x, y: 0, width: 0.2, layer: "top" },
    { route_type: "wire", x, y: 5, width: 0.2, layer: "top" },
  ],
});
const via = (id: string, x: number) => ({ type: "pcb_via", pcb_via_id: id, x, y: 0, hole_diameter: 0.2, outer_diameter: 0.5, layers: ["top", "bottom"] });
const PULITA = [{ type: "pcb_board", pcb_board_id: "pcb_board_0" }, pista("pcb_trace_0", 0), pista("pcb_trace_1", 1), via("pcb_via_0", 3)];
// come quella delle 12:02:14: una pista e una via della scheda di prima, con l'id di quelle nuove
const SPORCA = [...PULITA, pista("pcb_trace_0", 7), via("pcb_via_0", 9)];

describe("gli id doppi di una scheda", () => {
  it("una scheda senza doppi non dice niente", () => {
    expect(idDoppi(PULITA)).toBeNull();
    expect(idDoppi([])).toBeNull();
  });

  it("conta gli elementi con l'id di un altro dello stesso tipo e li dice per tipo e per id", () => {
    const d = idDoppi(SPORCA);
    expect(d?.count).toBe(2);
    expect(d?.detail).toContain("2 elementi della scheda hanno l'id di un altro dello stesso tipo");
    expect(d?.detail).toContain("1 pcb_trace (pcb_trace_0)");
    expect(d?.detail).toContain("1 pcb_via (pcb_via_0)");
  });

  it("lo stesso id su due tipi diversi non e' un doppio, e nemmeno un errore o un elemento senza id", () => {
    expect(
      idDoppi([
        { type: "pcb_trace", pcb_trace_id: "x" },
        { type: "pcb_via", pcb_via_id: "x" },
        { type: "pcb_trace_error", pcb_trace_error_id: "e" },
        { type: "pcb_trace_error", pcb_trace_error_id: "e" },
        { type: "pcb_silkscreen_path" },
        { type: "pcb_silkscreen_path" },
        // i sorgenti e lo schematico non sono la scheda
        { type: "source_trace", source_trace_id: "s" },
        { type: "source_trace", source_trace_id: "s" },
      ]),
    ).toBeNull();
  });

  it("di tanti ne nomina i primi e dice quanti altri", () => {
    const tante = Array.from({ length: 7 }, (_, i) => pista(`pcb_trace_${i}`, i));
    const d = idDoppi([...tante, ...tante.map((p) => ({ ...p }))]);
    expect(d?.count).toBe(7);
    expect(d?.detail).toContain("7 pcb_trace (pcb_trace_0, pcb_trace_1, pcb_trace_2, pcb_trace_3 e altri 3)");
  });

  it("l'avviso entra nel messaggio del riepilogo una volta sola", () => {
    const summary = { message: "Compile OK." };
    const d = idDoppi(SPORCA)!;
    avvisaDegliIdDoppi(summary, d);
    avvisaDegliIdDoppi(summary, d);
    expect(summary.message.startsWith("Compile OK. ")).toBe(true);
    expect(summary.message.split(AVVISO_ID_DOPPI)).toHaveLength(2);
    expect(summary.message).toContain("pcb_trace_0");
    // un riepilogo che non e' un oggetto non rompe il salvataggio
    expect(() => avvisaDegliIdDoppi(null, d)).not.toThrow();
  });
});

describe("il salvataggio di una scheda con id doppi", () => {
  const errore = vi.spyOn(console, "error").mockImplementation(() => {});
  beforeEach(() => {
    query.fatte = [];
    errore.mockClear();
    process.env.DATABASE_URL = "postgres://finto";
  });
  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  /** il riepilogo scritto nel database dall'ultima INSERT della scheda */
  const riepilogoSalvato = () => {
    const insert = query.fatte.filter((q) => q.testo.includes("INSERT INTO project_compiles")).pop();
    return insert ? (JSON.parse(String(insert.valori[3])) as { message: string }) : null;
  };

  it("la salva, e lo dice nel riepilogo salvato e nel registro", async () => {
    const summary = { ok: true, errors: [], message: "Compile OK." };
    const r = await saveCompileCache("prova-doppi", "h1", SPORCA, summary, 11);
    expect(r.saved).toBe(true);
    expect(riepilogoSalvato()?.message).toContain(AVVISO_ID_DOPPI);
    expect(riepilogoSalvato()?.message).toContain("1 pcb_trace (pcb_trace_0)");
    // chi ha compilato risponde con lo stesso riepilogo: lo legge anche li'
    expect(summary.message).toContain(AVVISO_ID_DOPPI);
    expect(errore).toHaveBeenCalledTimes(1);
    expect(String(errore.mock.calls[0][0])).toContain("prova-doppi");
  });

  it("anche quando salva solo sopra la riga che ha letto (aggiornamento veloce, ricontrollo)", async () => {
    const summary = { ok: true, errors: [], message: "Compile OK." };
    await saveCompileCache("prova-doppi", "h1", SPORCA, summary, 11, { ifUnchangedSince: { filesHash: "h0", createdAt: "2026-11-12T11:02:14.186Z" } });
    expect(riepilogoSalvato()?.message).toContain(AVVISO_ID_DOPPI);
  });

  it("una scheda senza doppi si salva com'e', senza una parola in piu'", async () => {
    const summary = { ok: true, errors: [], message: "Compile OK." };
    const r = await saveCompileCache("prova-doppi", "h1", PULITA, summary, 11);
    expect(r.saved).toBe(true);
    expect(riepilogoSalvato()?.message).toBe("Compile OK.");
    expect(errore).not.toHaveBeenCalled();
  });
});
