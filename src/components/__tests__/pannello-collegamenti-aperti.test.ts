import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StatoAperti } from "../board/CollegamentiAperti";
import { ElencoAperti, facceDelTratto, riassuntoAperti, vociPerRete } from "../workspace/ElencoAperti";
import { RightRail } from "../workspace/RightRail";
import { buildBoardReport } from "@/lib/board-report";
import { apertiDellaScheda } from "@/lib/open-connections";
import { pezzo, rete, scheda, trace, wire, type El } from "@/lib/__tests__/scheda-di-prova";

/*
 * Il pannello diceva "Collegamenti aperti 2" e basta. Ora il contatore e' un
 * interruttore che li mette sulla scheda in ogni vista, e sotto c'e' l'elenco:
 * rete e i due piedini, e un clic porta la scheda su quel collegamento.
 */
/** R1 e R2 unite da una pista, R3 fuori: un collegamento aperto, da R3 a R2 */
const UNO_APERTO: El[] = [
  scheda(2),
  ...pezzo("R1", [["1", 0, 0]]),
  ...pezzo("R2", [["1", 5, 0]]),
  ...pezzo("R3", [["1", 12, 0]]),
  ...rete(1, "SDA", ["R1_1", "R2_1", "R3_1"]),
  trace("t1", "st_SDA_0", [wire(0, 0), wire(5, 0)]),
];

describe("il pannello: il contatore e' un interruttore, sotto c'e' l'elenco", () => {
  /** due reti: SDA con un tratto, GND senza rame con tre piedini (due tratti) */
  const DUE_RETI: El[] = [
    ...UNO_APERTO,
    ...pezzo("C1", [["2", 0, 5]]),
    ...pezzo("C2", [["2", 4, 5]]),
    ...pezzo("C3", [["2", 8, 5, "bottom"]]),
    ...rete(2, "GND", ["C1_2", "C2_2", "C3_2"]),
  ];
  const stato = (accesi: boolean, scelto: StatoAperti["scelto"] = null): StatoAperti => ({
    elenco: apertiDellaScheda(DUE_RETI),
    accesi,
    setAccesi: () => {},
    scelto,
    scegli: () => {},
  });
  const pannello = (s: StatoAperti, dichiarati = 2) => renderToStaticMarkup(createElement(ElencoAperti, { aperti: s, dichiarati }));

  it("spento: il contatore con quanti sono e in quante reti, niente elenco", () => {
    const html = pannello(stato(false));
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Collegamenti aperti");
    expect(html).toContain("3 in 2 reti");
    expect(html).not.toContain("R3.1");
  });

  it("acceso: rete e i due piedini di ogni tratto, la rete con un tratto solo per prima", () => {
    const html = pannello(stato(true));
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("3 in 2 reti");
    // SDA ha un tratto: scritto per intero, piedini e faccia
    expect(html).toContain("R3.1 → R2.1");
    expect(html).toContain("Top");
    expect(html).toContain("7 mm");
    // GND ne ha due: una riga che si apre
    expect(html).toContain("I 2 collegamenti aperti di questa rete");
    expect(html.indexOf("SDA")).toBeLessThan(html.indexOf("GND"));
  });

  it("quello scelto e' segnato nell'elenco col colore dei collegamenti aperti", () => {
    const html = pannello(stato(true, { id: "SDA#0", n: 1 }));
    expect(html).toContain("border-color:#FF4FE0");
  });

  it("le voci: per rete, poche prima; i capi su due facce si dicono", () => {
    const voci = vociPerRete(apertiDellaScheda(DUE_RETI).collegamenti);
    expect(voci.map((v) => [v.titolo, v.tratti.length])).toEqual([
      ["SDA", 1],
      ["GND", 2],
    ]);
    const versoIlBottom = voci[1].tratti.find((c) => c.da.strato !== c.a.strato)!;
    // da C2 sul top a C3 sul bottom
    expect(facceDelTratto(versoIlBottom)).toBe("Top → Bottom");
    expect(facceDelTratto(voci[0].tratti[0])).toBe("Top");
    expect(facceDelTratto({ da: { strato: null }, a: { strato: "bottom" } } as never)).toBe("passante → Bottom");
  });

  it("il controllo conta le stesse reti: se quello salvato ne dice un altro numero, va ricontrollato", () => {
    const tratti = apertiDellaScheda(DUE_RETI).collegamenti;
    // due reti aperte, tre tratti: il controllo ne conta due. Niente da dire
    expect(riassuntoAperti(tratti, 2)).toEqual(["3 in 2 reti"]);
    // un controllo salvato prima che le colate si misurassero, o di un'altra scheda
    expect(riassuntoAperti(tratti, 1)).toEqual(["3 in 2 reti", "Il controllo salvato conta 1 rete aperta: ricontrolla la scheda"]);
    expect(riassuntoAperti(tratti, 5)).toEqual(["3 in 2 reti", "Il controllo salvato conta 5 reti aperte: ricontrolla la scheda"]);
    expect(riassuntoAperti(tratti.slice(0, 1), 1)).toEqual(["1"]);
  });
});

describe("nel pannello di destra, al posto del solo numero", () => {
  const riepilogo = (aperte: string[]) => ({ errors: [], drcViolations: [], prcViolations: [], unroutedConnections: aperte, unroutedTotal: aperte.length });
  const rail = (circuito: El[], aperte: string[], tab: string, accesi = false) =>
    renderToStaticMarkup(
      createElement(RightRail, {
        tab,
        report: buildBoardReport(circuito, riepilogo(aperte) as never),
        erc: null,
        compiledAgo: "ricompila",
        onAsk: () => {},
        onShowOnBoard: () => {},
        onRecompile: () => {},
        recompiling: false,
        enclosures: null,
        aperti: { elenco: apertiDellaScheda(circuito), accesi, setAccesi: () => {}, scelto: null, scegli: () => {} },
      } as never),
    );

  it("sulla scheda con un collegamento aperto: l'interruttore, e acceso l'elenco", () => {
    const spento = rail(UNO_APERTO, [".R3 > .1 to net.SDA"], "pcb");
    expect(spento).toContain('aria-pressed="false"');
    expect(spento).not.toContain("R3.1 → R2.1");
    const acceso = rail(UNO_APERTO, [".R3 > .1 to net.SDA"], "pcb", true);
    expect(acceso).toContain('aria-pressed="true"');
    expect(acceso).toContain("R3.1 → R2.1");
  });

  it("sullo schematico resta la riga di prima, col numero del controllo", () => {
    const html = rail(UNO_APERTO, [".R3 > .1 to net.SDA"], "schematic");
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain("Collegamenti aperti");
  });

  it("rete tutta unita: Collegamenti completi, nessun interruttore", () => {
    const unita = [...UNO_APERTO, trace("t2", "st_SDA_2", [wire(5, 0), wire(12, 0)])];
    const html = rail(unita, [], "pcb");
    expect(html).toContain("Collegamenti completi");
    expect(html).not.toContain("aria-pressed");
  });
});
