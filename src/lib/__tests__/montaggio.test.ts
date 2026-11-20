import { beforeAll, describe, expect, it } from "vitest";
import { compileProject } from "@/lib/compile";
import { nonCertificata } from "@/lib/engine-version";
import { improntePerCodici, leggiImprontaEasyEda, type ImprontaLcsc } from "@/lib/lcsc-impronte";
import {
  CONVENZIONE,
  csvDiMontaggio,
  disegnoDiMontaggio,
  montaggio,
  montaggioDaCertificare,
  noteDiMontaggio,
  piazza,
  pezziMontati,
  verificaMontaggio,
  type RigaDiMontaggio,
} from "@/lib/montaggio";

/*
 * Il pacchetto di montaggio in una convenzione sola (JLCPCB / EasyEDA, quella con cui PCB Basic ha montato giusti gli
 * integrati della sonda): rotazioni dall'impronta LCSC di ogni pezzo, decise per FUNZIONE dei pin; confronto per nome
 * con l'impronta LCSC; verifica indipendente; tabella a parole; disegni di montaggio. Le impronte sono quelle che
 * risponde EasyEDA (C2286, il LED della sonda), costruite qui: nessuna rete nei test.
 */
type El = Record<string, unknown> & { type: string };

const pad = (num: string, nome: string, x: number, y = 0, w = 0.8, h = 0.8) => ({ num, nome, x, y, w, h });
/** C2286, il LED KT-0603R della sonda: piazzola 2 = K a sinistra, 1 = A a destra (come risponde EasyEDA) */
const C2286: ImprontaLcsc = { codice: "C2286", titolo: "KT-0603R", impronta: "LED-SMD_L1.6-W0.8-R-RD", pads: [pad("2", "K", -0.75), pad("1", "A", 0.75)] };
/** un LED con la piazzola 1 sul catodo, come il Wurth 150060SS75000 */
const WURTH: ImprontaLcsc = { codice: "C6784992", titolo: "150060SS75000", impronta: "LED-0603", pads: [pad("1", "K", -0.75), pad("2", "A", 0.75)] };
/** un TVS bidirezionale disegnato come diodo, come C779408 (TPD1E1B04): «BI» nel nome dell'impronta */
const TVS: ImprontaLcsc = { codice: "C779408", titolo: "TPD1E1B04DPYR", impronta: "X1SON-2_L1.0-W0.6-P0.65-BI-1", pads: [pad("1", "C", -0.75), pad("2", "A", 0.75)] };

const MAIN = `export default () => (
  <board width="40mm" height="24mm">
    <net name="GND" /><net name="V" />
    <led name="D1" footprint="0603" pcbX={-12} pcbY={6} supplierPartNumbers={{ jlcpcb: ["C2286"] }} />
    <led name="D2" footprint="0603" pcbX={-6} pcbY={6} pcbRotation={90} supplierPartNumbers={{ jlcpcb: ["C6784992"] }} />
    <led name="D3" footprint="0603" layer="bottom" pcbX={0} pcbY={6} pcbRotation={90} supplierPartNumbers={{ jlcpcb: ["C2286"] }} />
    <diode name="D4" footprint="0603" pcbX={6} pcbY={6} supplierPartNumbers={{ jlcpcb: ["C779408"] }} />
    <resistor name="R1" resistance="1k" footprint="0603" pcbX={-12} pcbY={-6} pcbRotation={90} />
    <resistor name="R2" resistance="1k" footprint="0603" layer="bottom" pcbX={-6} pcbY={-6} pcbRotation={90} />
    <chip name="U1" footprint="soic8" pcbX={8} pcbY={-6} />
    <trace from=".D1 > .anode" to="net.V" /><trace from=".D1 > .cathode" to="net.GND" />
  </board>
)`;

let cj: El[];
const impronte = new Map<string, ImprontaLcsc | null>([
  ["C2286", C2286],
  ["C6784992", WURTH],
  ["C779408", TVS],
]);
beforeAll(async () => {
  cj = (await compileProject({ "main.tsx": MAIN })).circuitJson as El[];
}, 120_000);

const riga = (righe: RigaDiMontaggio[], d: string) => righe.find((r) => r.designator === d)!;

describe("la convenzione JLCPCB / EasyEDA", () => {
  it("top: rotazione antioraria dell'impronta a 0 gradi; bottom: x e y viste da sopra, rotazione vista da sotto", () => {
    expect(piazza(90, { x: 1, y: 0 }, "top")).toEqual({ x: expect.closeTo(0, 9), y: expect.closeTo(1, 9) });
    // al bottom: lo specchio della x, poi la rotazione all'indietro
    expect(piazza(90, { x: 1, y: 0 }, "bottom")).toEqual({ x: expect.closeTo(0, 9), y: expect.closeTo(1, 9) });
    expect(piazza(0, { x: 1, y: 0 }, "bottom")).toEqual({ x: expect.closeTo(-1, 9), y: expect.closeTo(0, 9) });
  });
});

describe("il pick and place", () => {
  it("il catodo dell'impronta LCSC va sul nostro catodo, deciso per funzione; il verificatore indipendente non trova scarti", () => {
    const { righe } = montaggio(cj, impronte);
    for (const d of ["D1", "D2", "D3"]) {
      expect(riga(righe, d).riferimento).toBe("lcsc");
      expect(riga(righe, d).deciso).toBe("funzione");
    }
    // D1, a 0 gradi: il nostro catodo (pin 2) e' a destra, il K di C2286 a sinistra: mezzo giro
    expect(riga(righe, "D1").rotation).toBe(180);
    expect(verificaMontaggio(cj, righe, impronte)).toEqual([]);
  });

  it("una rotazione sbagliata a mano e' presa dal verificatore", () => {
    const { righe } = montaggio(cj, impronte);
    const girate = righe.map((r) => (r.designator === "D1" ? { ...r, rotation: (Number(r.rotation) + 180) % 360 } : r));
    expect(verificaMontaggio(cj, girate, impronte).join(" ")).toMatch(/D1: seguendo il pick and place il catodo dell'impronta LCSC C2286 cade sulla piazzola sbagliata/);
    const motivo = nonCertificata({ assembly: montaggioDaCertificare(verificaMontaggio(cj, girate, impronte)) });
    expect(motivo).toMatch(/il pick and place non passa la sua verifica: D1.*NON e' certificata per l'export finche' il pick and place non mette ogni pezzo nel suo verso/);
  });

  it("senza impronta LCSC: un passivo a due piazzole usa il chip di EasyEDA; il resto l'angolo della nostra impronta, al bottom visto da sotto", () => {
    const { righe } = montaggio(cj, impronte);
    expect(riga(righe, "R1").riferimento).toBe("chip generico");
    expect(riga(righe, "U1").riferimento).toBe("nostra impronta");
    // U1 senza codice LCSC resta col suo angolo (0 al top)
    expect(riga(righe, "U1").rotation).toBe(0);
    // R2 al bottom: con l'impronta a chip, la rotazione e' letta da sotto
    const r2 = pezziMontati(cj).find((p) => p.nome === "R2")!;
    expect(r2.faccia).toBe("bottom");
    expect([90, 270]).toContain(riga(righe, "R2").rotation);
  });

  it("il CSV ha l'intestazione che JLCPCB legge", () => {
    const csv = csvDiMontaggio(montaggio(cj, impronte).righe);
    expect(csv.split("\r\n")[0]).toBe("Designator,Mid X,Mid Y,Layer,Rotation");
    expect(csv).toMatch(/"D1",-?\d+\.\d{3},-?\d+\.\d{3},"top",180/);
  });
});

describe("il confronto per nome con l'impronta LCSC", () => {
  it("numerazione opposta (LED Wurth: piazzola 1 = catodo): avviso esplicito, e la rotazione resta giusta per nome", () => {
    const { avvisi } = montaggio(cj, impronte);
    const d2 = avvisi.filter((a) => a.nome === "D2");
    expect(d2.map((a) => a.messaggio).join(" ")).toMatch(/D2: la numerazione delle piazzole e' OPPOSTA a quella dell'impronta LCSC C6784992 \(LCSC: piazzola 1 = catodo; progetto: piazzola 1 = anodo\)/);
    // C2286 ha la piazzola 1 sull'anodo come noi: niente avviso per D1
    expect(avvisi.filter((a) => a.nome === "D1")).toEqual([]);
  });

  it("un'impronta LCSC di un pezzo bidirezionale (BI) lo dice", () => {
    const { avvisi } = montaggio(cj, impronte);
    expect(avvisi.find((a) => a.nome === "D4")?.messaggio).toMatch(/BIDIREZIONALE: se lo e', scrivi «bidirezionale» nella description/);
  });
});

describe("note e disegni", () => {
  it("le note dichiarano la convenzione e dicono il verso di ogni pezzo a parole, rispetto al pezzo vicino", () => {
    const { righe, avvisi } = montaggio(cj, impronte);
    const note = noteDiMontaggio(cj, righe, avvisi, "prova");
    expect(note).toContain(CONVENZIONE);
    expect(note).toContain("3. POLARITY AND PIN 1 IN WORDS");
    expect(note).toMatch(/D1 \(top\): cathode \(K, bar\) on the pad at \(-?\d+\.\d\d; -?\d+\.\d\d\) mm, seen from the top, the pad nearer to \w+; anode on the other pad/);
    expect(note).toMatch(/U1 \(top\): pin 1 \(dot\)/);
    expect(note).toMatch(/Rows from our own footprint \(no LCSC footprint for the code\): U1/);
  });

  it("i disegni: punto rosso al pin 1, barra con K sul catodo, legenda giusta; il bottom e' visto da sotto", () => {
    const top = disegnoDiMontaggio(cj, "top", "prova");
    expect(top).toContain("TOP side, seen from the top");
    expect(top).toContain("Red dot = pin 1 (contact A1)    Bar with K = cathode    + = positive terminal");
    expect(top).toMatch(/<circle [^>]*fill="#e00000"/);
    expect(top).toMatch(/>K<\/text>/);
    const bottom = disegnoDiMontaggio(cj, "bottom", "prova");
    expect(bottom).toContain("BOTTOM side, seen from the BOTTOM (mirrored)");
    expect(bottom).toContain(">D3<");
    expect(bottom).not.toContain(">D1<");
  });
});

describe("le impronte LCSC lette da EasyEDA", () => {
  /** la risposta di EasyEDA per C2286 ridotta a pin e piazzole, com'e' (unita' da 10 mil, y in giu') */
  const RISPOSTA = {
    title: "KT-0603R",
    dataStr: {
      shape: [
        "P~show~0~2~-20~-5~180~gge28~0^^-20~-5^^M -20 -5 h 15~#800^^0~-1~-5~0~K~start~~~#800^^0~-9~-9~0~2~end~~~#800^^0~-8~-5^^0~M -5 -2 L -2 -5 L -5 -8",
        "P~show~0~1~20~-5~0~gge37~0^^20~-5^^M 20 -5 h -15~#800^^0~1~-5~0~A~end~~~#800^^0~9~-9~0~1~start~~~#800^^0~8~-5^^0~M 5 -8 L 2 -5 L 5 -2",
      ],
    },
    packageDetail: {
      title: "LED-SMD_L1.6-W0.8-R-RD",
      dataStr: {
        head: { x: "4000.8828", y: "3003.1398" },
        shape: [
          "PAD~RECT~3997.93~3003.14~3.1496~3.1496~1~~2~0~3996.3553 3001.565 3999.5049 3001.565 3999.5049 3004.7146 3996.3553 3004.7146~0~gge5~0~~Y~0~0~0.2~3997.9298,3003.1398",
          "PAD~RECT~4003.836~3003.14~3.1496~3.1496~1~~1~0~4002.2608 3001.565 4005.4104 3001.565 4005.4104 3004.7146 4002.2608 3004.7146~0~gge15~0~~Y~0~0~0.2~4003.8358,3003.1398",
        ],
      },
    },
  };

  it("piazzole in mm rispetto all'origine, col nome del pin dal simbolo", () => {
    const e = leggiImprontaEasyEda("C2286", RISPOSTA)!;
    expect(e.impronta).toBe("LED-SMD_L1.6-W0.8-R-RD");
    const k = e.pads.find((p) => p.num === "2")!;
    const a = e.pads.find((p) => p.num === "1")!;
    expect(k.nome).toBe("K");
    expect(a.nome).toBe("A");
    expect(k.x).toBeCloseTo(-0.75, 2);
    expect(a.x).toBeCloseTo(0.75, 2);
    expect(leggiImprontaEasyEda("C1", { packageDetail: {} })).toBeNull();
    expect(leggiImprontaEasyEda("C1", "non json")).toBeNull();
  });

  it("chiede a EasyEDA solo i codici che non ha, ricorda anche quelli senza impronta, e nei test non va in rete da sola", async () => {
    const chieste: string[] = [];
    const fetcher = (async (url: string) => {
      const codice = /products\/(C\d+)\//.exec(String(url))![1];
      chieste.push(codice);
      return new Response(JSON.stringify(codice === "C2286" ? { success: true, result: RISPOSTA } : { success: true, result: null }));
    }) as unknown as typeof fetch;
    const a = await improntePerCodici(["C2286", "C99999999", "non-un-codice"], { fetcher });
    expect(a.get("C2286")?.pads).toHaveLength(2);
    expect(a.get("C99999999")).toBeNull();
    expect(a.has("non-un-codice")).toBe(false);
    const b = await improntePerCodici(["C2286", "C99999999"], { fetcher });
    expect(b.get("C2286")?.codice).toBe("C2286");
    expect(chieste).toEqual(["C2286", "C99999999"]);
    // senza un fetch dato, nei test nessuna richiesta: i codici mai letti mancano
    expect((await improntePerCodici(["C12345"])).has("C12345")).toBe(false);
  });
});
