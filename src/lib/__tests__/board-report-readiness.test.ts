import { describe, expect, it } from "vitest";
import { buildBoardReport } from "@/lib/board-report";

/*
 * "PRONTA PER LA FABBRICA 100%" on fototrappola-frontale (09/11/2026): a board
 * with no saved compile and not a single trace. With no data every check came
 * out "ok" and the score was 100. The score must never be 100 while something
 * is missing, and it must say what.
 */

const board = { type: "pcb_board", width: 57, height: 57, num_layers: 4 };

const cleanSummary = {
  errors: [],
  drcViolations: [],
  prcViolations: [],
  unroutedConnections: [],
};

describe("pronta per la fabbrica", () => {
  it("senza compilazione salvata non e' pronta e dice cosa manca", () => {
    const r = buildBoardReport(null, null);
    expect(r.readiness).toBe(0);
    expect(r.ready).toBe(false);
    expect(r.compiled).toBe(false);
    expect(r.missing.join(" ")).toMatch(/compilat/i);
    // no check may claim "ok" about a board nobody has checked
    expect(r.checks.every((c) => c.severity !== "ok")).toBe(true);
  });

  it("un'anteprima a schermo non e' una scheda salvata", () => {
    const r = buildBoardReport([board], cleanSummary, { saved: false });
    expect(r.ready).toBe(false);
    expect(r.readiness).toBeLessThan(100);
    expect(r.missing.length).toBeGreaterThan(0);
  });

  it("con reti non instradate non arriva a 100 e il punteggio segue le reti chiuse", () => {
    const unrouted = Array.from({ length: 40 }, (_, i) => `.R${i} > .pin1 to net.GND`);
    const r = buildBoardReport([board], { ...cleanSummary, unroutedConnections: unrouted, unroutedTotal: 150, connectionGroups: 150 }, { saved: true });
    expect(r.ready).toBe(false);
    // nothing routed at all: a board with no copper is not 82% ready
    expect(r.readiness).toBe(0);
    expect(r.unrouted).toBe(150);
    expect(r.missing.join(" ")).toMatch(/150 reti non instradate/);
  });

  it("con errori DRC non e' pronta", () => {
    const r = buildBoardReport(
      [board],
      { ...cleanSummary, drcViolations: [{ rule: "clearance", message: "pad troppo vicini" }] },
      { saved: true },
    );
    expect(r.ready).toBe(false);
    expect(r.readiness).toBeLessThan(100);
    expect(r.missing.join(" ")).toMatch(/Distanze minime/);
  });

  it("con gli errori della compilazione non e' pronta", () => {
    const r = buildBoardReport(
      [board],
      { ...cleanSummary, errors: [{ type: "pcb_port_not_connected_error", message: "porta scollegata" }] },
      { saved: true },
    );
    expect(r.ready).toBe(false);
    expect(r.readiness).toBeLessThan(100);
  });

  it("con i sorgenti cambiati dopo la compilazione non e' pronta", () => {
    const r = buildBoardReport([board], cleanSummary, { saved: true, stale: true });
    expect(r.ready).toBe(false);
    expect(r.readiness).toBeLessThan(100);
    expect(r.missing.join(" ")).toMatch(/Ricompila/);
  });

  it("solo una scheda salvata, aggiornata e pulita e' pronta al 100%", () => {
    const r = buildBoardReport([board], cleanSummary, { saved: true, stale: false });
    expect(r.ready).toBe(true);
    expect(r.readiness).toBe(100);
    expect(r.missing).toEqual([]);
  });
});

describe("scheda salvata prima dello schematico", () => {
  it("non e' pronta finche' lo schematico non e' calcolato", () => {
    const r = buildBoardReport(
      [board],
      { ...cleanSummary, schematicPending: "scheda salvata prima dello schematico" },
      { saved: true },
    );
    expect(r.ready).toBe(false);
    expect(r.missing.join(" ")).toMatch(/schematico/);
  });
});

describe("scheda senza schematico riscritta da un altro percorso", () => {
  // "Applica", una pista a mano, un ricontrollo scrivono un riepilogo loro, senza il segnale
  it("se ha pezzi e nessun simbolo nello schematico non e' pronta", () => {
    const parts = [board, { type: "source_component", source_component_id: "s1", name: "R1" }];
    const r = buildBoardReport(parts, cleanSummary, { saved: true });
    expect(r.ready).toBe(false);
    expect(r.missing.join(" ")).toMatch(/schematico/);
    const withSchematic = [...parts, { type: "schematic_component", source_component_id: "s1" }];
    expect(buildBoardReport(withSchematic, cleanSummary, { saved: true }).ready).toBe(true);
  });
});

describe("rame di un'altra rete dentro una colata", () => {
  // what the summary carries after a fast update that laid a trace across the old ground pour (CompileSummary.poursOverCopper)
  const detail =
    "1 pista sta nel rame di una colata di un'altra rete (la pista .R1 > .pin2 to .R2 > .pin1 nella colata GND su top): e' un corto";
  const conIlCorto = {
    ...cleanSummary,
    drcViolations: [{ rule: "pour_clearance", message: "pcb_trace_manual_0 (.R1 > .pin2 to .R2 > .pin1) <-> GND pour on top: 0.000mm < min 0.2mm (the trace is in the copper of the pour: a short)" }],
    poursOverCopper: { count: 1, detail },
  };

  it("non e' pronta, lo dice per primo e in italiano, con la pista, lo strato e cosa fare", () => {
    const r = buildBoardReport([board], conIlCorto, { saved: true });
    expect(r.ready).toBe(false);
    expect(r.readiness).toBeLessThan(100);
    expect(r.missing[0]).toBe("c'e' rame di un'altra rete dentro una colata (un corto): premi Aggiorna per rifare le colate");
    const distanze = r.checks.find((c) => c.id === "clear")!;
    expect(distanze).toMatchObject({ severity: "err", count: "1 segnalazione", detail: `${detail}. Premi Aggiorna per rifare le colate.` });
  });

  it("senza quella voce la riga delle distanze dice quello che diceva", () => {
    const r = buildBoardReport([board], { ...conIlCorto, poursOverCopper: undefined }, { saved: true });
    expect(r.checks.find((c) => c.id === "clear")).toMatchObject({ severity: "err", count: "1 segnalazione", detail: conIlCorto.drcViolations[0].message.slice(0, 130) });
    expect(r.missing).toEqual(["Distanze minime: 1 segnalazione"]);
    expect(buildBoardReport([board], cleanSummary, { saved: true }).checks.find((c) => c.id === "clear")).toMatchObject({ severity: "ok", count: "ok" });
  });
});
