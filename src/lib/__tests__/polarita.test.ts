import { beforeAll, describe, expect, it } from "vitest";
import { compileProject } from "@/lib/compile";
import { nonCertificata } from "@/lib/engine-version";
import { controllaPolarita, pezziConVerso, polaritaDellaSchedaCheEsce } from "@/lib/polarita";

/*
 * I pezzi con un verso sono un obbligo (Niccolo', 2026-11-20, dopo il LED
 * montato al contrario sul primo pezzo della sonda del suolo): ruoli dei pin
 * per nome e segno in serigrafia dal lato giusto, controllati a ogni
 * compilazione (regola «polarita») e bloccanti per la certificazione dell'export.
 * Le schede sono compilate davvero da tscircuit.
 */
type El = Record<string, unknown> & { type: string };

const pezzi = `
    <net name="GND" /><net name="V" />
    <led name="D1" footprint="0603" pcbX={-15} pcbY={5} />
    <diode name="D2" footprint="0603" pcbX={-10} pcbY={5} />
    <chip name="U1" footprint="soic8" pcbX={0} pcbY={5} />
    <capacitor name="C1" capacitance="10uF" footprint="0805" polarized pcbX={-15} pcbY={-5} />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={10} pcbY={-5} />
    <led name="D5" footprint="0603" layer="bottom" pcbX={15} pcbY={-5} />
    <trace from=".D1 > .anode" to="net.V" /><trace from=".D1 > .cathode" to="net.GND" />`;
/** gli stessi pezzi senza segni, e un <chip> usato come diodo coi piedini chiamati solo 1 e 2 */
const SENZA = `export default () => (
  <board width="44mm" height="20mm">${pezzi}
    <chip name="D3" footprint="0603" pcbX={10} pcbY={5} />
  </board>
)`;
/** con i segni giusti: punto al pin 1 di U1, «+» accanto al + di C1, D3 coi nomi */
const CON = `export default () => (
  <board width="44mm" height="20mm">${pezzi}
    <chip name="D3" footprint="0603" pinLabels={{ pin1: "A", pin2: "K" }} pcbX={10} pcbY={5} />
    <silkscreencircle pcbX={-3.6} pcbY={7.6} radius={0.2} />
    <silkscreentext text="+" pcbX={-17.2} pcbY={-5} fontSize={0.8} />
  </board>
)`;

let senza: El[];
let con: El[];
let riassuntoSenza: Awaited<ReturnType<typeof compileProject>>["summary"];
beforeAll(async () => {
  const a = await compileProject({ "main.tsx": SENZA });
  senza = a.circuitJson as El[];
  riassuntoSenza = a.summary;
  con = (await compileProject({ "main.tsx": CON })).circuitJson as El[];
}, 240_000);

const silkDi = (cj: El[], nome: string) => {
  const sc = cj.find((e) => e.type === "source_component" && e.name === nome)!;
  const pc = cj.find((e) => e.type === "pcb_component" && e.source_component_id === sc.source_component_id)!;
  return cj.filter((e) => String(e.type).startsWith("pcb_silkscreen") && e.pcb_component_id === pc.pcb_component_id);
};

describe("quali pezzi hanno un verso", () => {
  it("LED, diodo, condensatore polarizzato, integrato col pin 1 e <chip> chiamato come un diodo; non la resistenza", () => {
    const p = pezziConVerso(senza);
    expect(p.map((q) => [q.nome, q.tipo, q.riferimento]).sort()).toEqual([
      ["C1", "condensatore", "piu"],
      ["D1", "led", "catodo"],
      ["D2", "diodo", "catodo"],
      ["D3", "diodo", "catodo"],
      ["D5", "led", "catodo"],
      ["U1", "integrato", "pin1"],
    ]);
  });
});

describe("la serigrafia di <led> e <diode>: barra sul catodo e «+» sull'anodo", () => {
  it("al posto della U chiusa sull'anodo di tscircuit", () => {
    for (const nome of ["D1", "D2", "D5"]) {
      const s = silkDi(senza, nome);
      const p = pezziConVerso(senza).find((q) => q.nome === nome)!;
      // nessuna U: un tratto di due punti (la barra) e il testo «+»
      const tratti = s.filter((e) => e.type === "pcb_silkscreen_path") as Array<El & { route: Array<{ x: number; y: number }> }>;
      expect(tratti.map((t) => t.route.length)).toEqual([2]);
      const barra = tratti[0].route;
      const mx = (barra[0].x + barra[1].x) / 2;
      // la barra sta oltre il catodo, dal lato opposto all'anodo
      expect(Math.abs(mx - p.chiave!.centro.x)).toBeLessThan(Math.abs(mx - p.altra!.centro.x));
      // sulla faccia del pezzo: il LED D5 sta sul bottom
      expect(s.filter((e) => e.type !== "pcb_silkscreen_text" || e.text === "+").every((e) => e.layer === p.faccia)).toBe(true);
      const piu = s.find((e) => e.type === "pcb_silkscreen_text" && e.text === "+") as El & { anchor_position: { x: number } };
      expect(Math.abs(piu.anchor_position.x - p.altra!.centro.x)).toBeLessThan(Math.abs(piu.anchor_position.x - p.chiave!.centro.x));
    }
  });
});

describe("la regola «polarita»", () => {
  it("senza segni: il pin 1 di U1, il «+» di C1 e i ruoli di D3; LED e diodo sono a posto da soli", () => {
    const p = controllaPolarita(senza);
    expect(p.map((q) => [q.nome, q.motivo]).sort()).toEqual([
      ["C1", "segno"],
      ["D3", "ruoli"],
      ["U1", "segno"],
    ]);
    expect(p.find((q) => q.nome === "U1")!.messaggio).toMatch(/nessun segno di pin 1 in serigrafia .* Aggiungi un punto \(<silkscreencircle>\) accanto al pin 1/);
    expect(p.find((q) => q.nome === "D3")!.messaggio).toMatch(/pinLabels=\{\{ pin1: "A", pin2: "K" \}\}/);
    // nei controlli della compilazione, in rosso, e la scheda compila
    expect(riassuntoSenza.errors).toEqual([]);
    const prc = riassuntoSenza.prcViolations.filter((v) => v.rule === "polarita");
    expect(prc).toHaveLength(3);
    expect(prc.every((v) => v.severity === "fail")).toBe(true);
  });

  it("con i segni giusti non dice niente; il <chip> coi nomi A e K prende anche lui barra e «+»", () => {
    expect(controllaPolarita(con)).toEqual([]);
    expect(silkDi(con, "D3").some((e) => e.type === "pcb_silkscreen_text" && e.text === "+")).toBe(true);
  });

  it("un segno dal lato dell'anodo che non e' un «+» si legge come catodo: segno_al_contrario", () => {
    // la U di tscircuit rimessa com'era sul LED D1 (chiusa oltre l'anodo, il pin 1)
    const d1 = pezziConVerso(con).find((q) => q.nome === "D1")!;
    const a = d1.altra!.centro;
    const k = d1.chiave!.centro;
    const u: El = {
      type: "pcb_silkscreen_path",
      pcb_silkscreen_path_id: "u",
      pcb_component_id: d1.id,
      layer: "top",
      stroke_width: 0.1,
      route: [
        { x: k.x, y: a.y + 0.88 },
        { x: a.x - 0.6, y: a.y + 0.88 },
        { x: a.x - 0.6, y: a.y - 0.88 },
        { x: k.x, y: a.y - 0.88 },
      ],
    };
    const senzaSegni = con.filter((e) => !(String(e.type).startsWith("pcb_silkscreen") && e.pcb_component_id === d1.id));
    const p = controllaPolarita([...senzaSegni, u]);
    expect(p.map((q) => [q.nome, q.motivo])).toEqual([["D1", "segno_al_contrario"]]);
    expect(p[0].messaggio).toMatch(/dal lato dell'ANODO e chi monta lo legge come catodo/);
  });

  it("un punto sotto il corpo o sopra una piazzola non e' un segno, e nemmeno il nome del pezzo", () => {
    const u1 = pezziConVerso(con).find((q) => q.nome === "U1")!;
    const senzaPunto = con.filter((e) => !(e.type === "pcb_silkscreen_circle"));
    const sotto: El = { type: "pcb_silkscreen_circle", pcb_silkscreen_circle_id: "s", layer: "top", center: { x: u1.chiave!.centro.x + 1.2, y: u1.chiave!.centro.y }, radius: 0.15, stroke_width: 0.1 };
    const sullaPiazzola: El = { type: "pcb_silkscreen_circle", pcb_silkscreen_circle_id: "p", layer: "top", center: u1.chiave!.centro, radius: 0.15, stroke_width: 0.1 };
    const nome: El = { type: "pcb_silkscreen_text", pcb_silkscreen_text_id: "n", layer: "top", text: "U1", font_size: 0.8, anchor_position: { x: u1.chiave!.centro.x - 1.6, y: u1.chiave!.centro.y + 0.8 }, anchor_alignment: "center" };
    for (const finto of [sotto, sullaPiazzola, nome]) {
      expect(controllaPolarita([...senzaPunto, finto]).map((q) => q.nome)).toEqual(["U1"]);
    }
    // sull'altra faccia non conta
    const dietro: El = { type: "pcb_silkscreen_circle", pcb_silkscreen_circle_id: "d", layer: "bottom", center: { x: -3.6, y: 7.6 }, radius: 0.2, stroke_width: 0.1 };
    expect(controllaPolarita([...senzaPunto, dietro]).map((q) => q.nome)).toEqual(["U1"]);
  });

  it("un pezzo non montato (doNotPlace) non e' controllato", () => {
    const u1 = senza.find((e) => e.type === "source_component" && e.name === "U1")!;
    const nonMontato = senza.map((e) => (e.type === "pcb_component" && e.source_component_id === u1.source_component_id ? { ...e, do_not_place: true } : e));
    expect(controllaPolarita(nonMontato).map((q) => q.nome).sort()).toEqual(["C1", "D3"]);
  });
});

describe("la certificazione dell'export", () => {
  it("una scheda con un pezzo senza segno non e' certificata, e lo dice coi nomi", () => {
    const polarity = polaritaDellaSchedaCheEsce(senza);
    expect(polarity?.count).toBe(3);
    const motivo = nonCertificata({ polarity });
    expect(motivo).toMatch(/3 pezzi con un verso non hanno i ruoli dei piedini o il segno in serigrafia \(.*U1.*\)\. La scheda NON e' certificata per l'export/);
    expect(polaritaDellaSchedaCheEsce(con)).toBeNull();
    expect(nonCertificata({ polarity: polaritaDellaSchedaCheEsce(con) })).toBeNull();
  });
});

describe("i due difetti trovati sulla HTL-401 (v0.48.0)", () => {
  const BIDIR = `export default () => (
  <board width="30mm" height="12mm">
    <diode name="D6" footprint="0603" description="TVS bidirezionale sulla misura del pannello" pcbX={-8} pcbY={0} />
    <chip name="D7" footprint="0603" description="ESD protection, bidirectional" pcbX={0} pcbY={0} />
    <diode name="D8" footprint="0603" manufacturerPartNumber="BIDIRECTIONAL-TVS" description="ESD sulla USB" pcbX={8} pcbY={0} />
  </board>
)`;
  let bidir: El[];
  beforeAll(async () => {
    bidir = (await compileProject({ "main.tsx": BIDIR })).circuitJson as El[];
  }, 120_000);

  it("un TVS bidirezionale si dichiara nella description (italiano o inglese), letta dai file; il nome o il codice non bastano", () => {
    const conIFile = controllaPolarita(bidir, { "main.tsx": BIDIR }).map((p) => p.nome);
    expect(conIFile).not.toContain("D6");
    expect(conIFile).not.toContain("D7");
    // D8 dice «bidirectional» solo nel codice: resta un diodo, e il messaggio dice cosa scrivere
    const d8 = controllaPolarita(bidir, { "main.tsx": BIDIR }).find((p) => p.nome === "D8");
    expect(d8).toBeUndefined(); // un <diode> di serie ha barra e «+» da solo: nessun problema di segno
    expect(pezziConVerso(bidir, { "main.tsx": BIDIR }).map((p) => p.nome)).toEqual(["D8"]);
    // senza i file la description non si vede: D7 resta un <chip> usato come diodo senza ruoli, e il messaggio dice la parola da scrivere
    const d7 = controllaPolarita(bidir).find((p) => p.nome === "D7")!;
    expect(d7.motivo).toBe("ruoli");
    expect(d7.messaggio).toContain(`scrivi nella description del pezzo la parola «bidirezionale» (o «bidirectional»), per esempio description="TVS bidirezionale sulla linea USB"`);
  });

  it("un segno disegnato sulla scheda e' del pezzo piu' vicino; a pari distanza da due pezzi non vale per nessuno e lo si dice", () => {
    // D1 senza i suoi segni, con una barra della scheda accanto al suo catodo
    const d1 = pezziConVerso(con).find((q) => q.nome === "D1")!;
    const k = d1.chiave!.centro;
    const a = d1.altra!.centro;
    const ux = Math.sign(k.x - a.x);
    // 0,25 mm oltre il bordo della piazzola del catodo
    const bordo = ux > 0 ? d1.chiave!.bounds.maxX : d1.chiave!.bounds.minX;
    const xb = bordo + ux * 0.25;
    const senzaSegni = con.filter((e) => !(String(e.type).startsWith("pcb_silkscreen") && e.pcb_component_id === d1.id));
    const barra: El = { type: "pcb_silkscreen_path", pcb_silkscreen_path_id: "barra", layer: "top", stroke_width: 0.12, route: [{ x: xb, y: k.y - 0.5 }, { x: xb, y: k.y + 0.5 }] };
    expect(controllaPolarita([...senzaSegni, barra]).map((q) => q.nome)).not.toContain("D1");
    // un altro pezzo con la piazzola (larga 0,3) a `d` mm dalla barra, dall'altra parte
    const vicino = (d: number, id: string): El[] => [
      { type: "pcb_component", pcb_component_id: id, source_component_id: `s_${id}`, layer: "top", center: { x: xb + ux * (d + 0.15), y: k.y }, rotation: 0 },
      { type: "pcb_smtpad", pcb_smtpad_id: `p_${id}`, pcb_component_id: id, shape: "rect", layer: "top", x: xb + ux * (d + 0.15), y: k.y, width: 0.3, height: 0.3 },
    ];
    // piu' vicino di D1 (0,25): la barra e' sua, D1 resta senza segno
    const conPiuVicino = controllaPolarita([...senzaSegni, barra, ...vicino(0.05, "altro_vicino")]);
    expect(conPiuVicino.find((q) => q.nome === "D1")?.motivo).toBe("segno");
    // alla stessa distanza di D1: conteso
    const conteso = controllaPolarita([...senzaSegni, barra, ...vicino(0.25, "altro_pari")]);
    const p = conteso.find((q) => q.nome === "D1")!;
    expect(p.motivo).toBe("segno_conteso");
    expect(p.messaggio).toMatch(/sta quasi alla stessa distanza da .* e non si sa di chi dei due e': non vale per nessuno/);
  });
});

describe("BGA senza sfera A1 e connettori che coprono il pin 1 (sbb-dl-principale, tm-4l-q1)", () => {
  // una griglia 3x3 passo 1 mm senza la sfera A1, come la PSRAM IC6: riga A in basso, colonna 1 a destra
  const sfere = ["A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"]
    .map((n) => {
      const riga = "ABC".indexOf(n[0]);
      const col = Number(n.slice(1));
      return `<smtpad portHints={["${n}"]} shape="circle" radius={0.15} pcbX={${2 - col}} pcbY={${riga - 1}} layer="top" />`;
    })
    .join("\n        ");
  const bga = (descrizione: string, punto: string) => `export default () => (
  <board width="20mm" height="20mm">
    <chip name="IC6" description="${descrizione}" pcbX={0} pcbY={0}
      footprint={<footprint>
        ${sfere}
      </footprint>} />
    ${punto}
  </board>
)`;
  // l'angolo A1 sta in (1; -1): il punto appena fuori, in basso a destra; l'angolo opposto (C3) in alto a sinistra
  const PUNTO_A1 = `<silkscreencircle pcbX={1.5} pcbY={-1.5} radius={0.15} />`;
  const PUNTO_C3 = `<silkscreencircle pcbX={-1.5} pcbY={1.5} radius={0.15} />`;
  const prova = async (descrizione: string, punto: string) => {
    const f = { "main.tsx": bga(descrizione, punto) };
    const cj = (await compileProject(f)).circuitJson as El[];
    return { pezzo: pezziConVerso(cj, f).find((p) => p.nome === "IC6"), problema: controllaPolarita(cj, f).find((p) => p.nome === "IC6") };
  };

  it("l'angolo A1 si ricava dalla griglia: il punto li' vale, quello sull'angolo opposto no; nessuna sfera va chiamata A1", async () => {
    const giusto = await prova("PSRAM", PUNTO_A1);
    expect(giusto.pezzo?.chiave?.nomi).toEqual(["A1 (angolo)"]);
    expect(giusto.pezzo?.chiave?.centro.x).toBeCloseTo(1, 5);
    expect(giusto.pezzo?.chiave?.centro.y).toBeCloseTo(-1, 5);
    expect(giusto.problema).toBeUndefined();
    const sbagliato = await prova("PSRAM", PUNTO_C3);
    expect(sbagliato.problema?.motivo).toBe("segno");
  }, 120_000);

  it("un pin 1 dichiarato nella description col nome del datasheet («pin 1 = C3») vince sulla griglia", async () => {
    const r = await prova("PSRAM, pin 1 = C3", PUNTO_C3);
    expect(r.pezzo?.chiave?.nomi).toContain("C3");
    expect(r.problema).toBeUndefined();
  }, 120_000);

  it("la distanza del segno si misura dal corpo del modello 3D: un punto appena fuori da un connettore che copre il pin 1 vale", async () => {
    const pin = [1, 2, 3, 4, 5, 6].map((n) => `<smtpad portHints={["${n}"]} shape="rect" width={0.6} height={1} pcbX={${n - 3.5}} pcbY={0} layer="top" />`).join("\n        ");
    const conn = (x: number) => `export default () => (
  <board width="20mm" height="20mm">
    <chip name="J3" pcbX={0} pcbY={0} cadModel={{ jscad: { type: "cuboid", size: [9, 6, 3], center: [0, 1, 1.5] } }}
      footprint={<footprint>
        ${pin}
      </footprint>} />
    <silkscreencircle pcbX={${x}} pcbY={0} radius={0.15} />
  </board>
)`;
    const cj = async (x: number) => {
      const f = { "main.tsx": conn(x) };
      const c = (await compileProject(f)).circuitJson as El[];
      return { c, f };
    };
    // il pin 1 sta in x = -2,5, il corpo arriva a -4,5: il punto in -4,8 e' a 2 mm dalla piazzola ma a 0,3 dal corpo
    const sinistra = await cj(-4.8);
    const j3 = pezziConVerso(sinistra.c, sinistra.f).find((p) => p.nome === "J3")!;
    expect(j3.corpo.minX).toBeCloseTo(-4.5, 5);
    expect(controllaPolarita(sinistra.c, sinistra.f).find((p) => p.nome === "J3")).toBeUndefined();
    // dall'altra parte del corpo, vicino al pin 6: non e' il segno del pin 1
    const destra = await cj(4.8);
    expect(controllaPolarita(destra.c, destra.f).find((p) => p.nome === "J3")?.motivo).toBe("segno");
  }, 120_000);
});
