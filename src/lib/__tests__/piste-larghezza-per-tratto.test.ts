import { beforeAll, describe, expect, it } from "vitest";
import { convertSoupToGerberCommands, stringifyGerberCommandLayers } from "circuit-json-to-gerber";
import { buildScene } from "@/components/board/render";
import { compileProject, type CompileResult } from "@/lib/compile";
import { resolveDesignRules } from "@/lib/design-rules";
import { runDrcChecks } from "@/lib/drc";
import { pisteAUnaLarghezza } from "@/lib/pours-recompute";
import { emptyManualEdits } from "@/lib/manual-edits";
import { percorsoDellaPista } from "@/lib/manual-routes";
import { iniziaGesto, preseDelRame } from "@/lib/spinta/gesto";
import { verificaRame } from "@/lib/spinta/verifica";

/*
 * UNA PISTA, PIU' LARGHEZZE (sbb-dl-principale, 15/11/2026). Le linee veloci
 * stanno a 50 ohm (0,32 mm sul top) e hanno piazzole strette ai due capi:
 * SDIO_CK va da U1 (piazzola 0,305 a passo 0,5) a FL1 (0,2 a passo 0,4) con un
 * collo stretto a ogni capo e 0,32 in mezzo. Una <trace pcbPath> aveva una
 * larghezza sola. Ora un punto del pcbPath puo' dire `width`: la larghezza
 * della pista da quel punto in avanti, fino al punto che ne dice un'altra.
 * Prima del primo vale thickness.
 *
 * Dove la larghezza cambia, la route del pcb_trace scrive il punto due volte,
 * con la larghezza di prima e con quella dopo: ogni tratto ha la stessa
 * larghezza ai due capi, e chi la legge dall'inizio del tratto (Gerber, SVG, i
 * controlli di tscircuit) o dalla fine (il visore, il DRC) legge la stessa.
 *
 * Qui la catena intera: compilazione, DRC, collegamenti, colate, visore,
 * Sposta e Gerber.
 */

type El = Record<string, unknown> & { type: string };
type Punto = { route_type: string; x: number; y: number; width?: number; layer?: string; [k: string]: unknown };

/*
 * R1.pin2 sta a (-7.175, 0), R2.pin1 a (7.175, 0). La pista esce dritta da R1
 * a 0,2 mm, a (-7.175, 2) diventa 0,6 fino a (0, 2), poi 0,2 fino sopra R2 e
 * scende dritta in R2. I punti del pcbPath sono relativi al centro di R1.
 */
const PISTA = (punti: string) =>
  `<trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPathRelativeTo=".R1 > .pin2" pcbPath={[${punti}]} thickness="0.2mm" />`;
const CON_LARGHEZZE = PISTA(`{ x: 0.825, y: 2, width: 0.6 }, { x: 8, y: 2, width: "0.2mm" }, { x: 15.175, y: 2 }`);
const scheda = (dentro: string) => `export default () => (
  <board width="30mm" height="16mm">
    <resistor name="R1" resistance="1k" footprint="0603" pcbX={-8} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0603" pcbX={8} pcbY={0} />
    ${dentro}
  </board>
)
`;

const piste = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");
const routeDi = (cj: unknown[], i = 0) => piste(cj)[i].route as Punto[];
/** the wire segments of a route, with the width read from the start and from the end */
const tratti = (route: Punto[]) =>
  route.slice(1).flatMap((b, i) => {
    const a = route[i];
    if (a.route_type !== "wire" || b.route_type !== "wire") return [];
    return [{ da: [a.x, a.y], a: [b.x, b.y], wDa: a.width, wA: b.width, lungo: Math.hypot(b.x - a.x, b.y - a.y) > 1e-9 }];
  });
const r3 = (v: number) => Math.round(v * 1000) / 1000;

describe("una pista con piu' larghezze", () => {
  let fatta: CompileResult;
  beforeAll(async () => {
    fatta = await compileProject({ "main.tsx": scheda(CON_LARGHEZZE) });
  }, 120_000);

  it("la compilazione scrive ogni tratto con la sua larghezza, uguale ai due capi", () => {
    const route = routeDi(fatta.circuitJson);
    expect(route.map((p) => [r3(p.x), r3(p.y), p.width])).toEqual([
      [-7.175, 0, 0.2],
      [-7.175, 2, 0.2],
      [-7.175, 2, 0.6],
      [0, 2, 0.6],
      [0, 2, 0.2],
      [7.175, 2, 0.2],
      [7.175, 0, 0.2],
    ]);
    // the two ends of the route are the two pads, as before
    expect(route[0].start_pcb_port_id).toBeTruthy();
    expect(route.at(-1)!.end_pcb_port_id).toBeTruthy();
    // read from either end, every segment of copper says one width (the step is a point, no copper of its own)
    for (const t of tratti(route).filter((x) => x.lungo)) expect(t.wDa).toBe(t.wA);
    expect(tratti(route).filter((t) => t.lungo).map((t) => t.wDa)).toEqual([0.2, 0.6, 0.2, 0.2]);
  });

  it("i collegamenti sono chiusi, nessuna pista resta a meta' e i controlli di tscircuit non dicono niente", () => {
    const s = fatta.summary;
    expect(s.unroutedTotal ?? 0).toBe(0);
    expect(s.unroutedConnections).toEqual([]);
    expect(s.message).not.toContain("non arrivano piu' su un pad");
    expect(s.errors).toEqual([]);
    // the width rule reads every segment: the 0.2 is above the minimum, nothing to say
    expect(s.drcViolations.filter((v) => v.rule === "min_trace_width")).toEqual([]);
  });

  it("una larghezza sotto il minimo si vede, anche se e' solo in un tratto", async () => {
    const stretta = await compileProject({
      "main.tsx": scheda(PISTA(`{ x: 0.825, y: 2, width: 0.1 }, { x: 8, y: 2, width: 0.2 }, { x: 15.175, y: 2 }`)),
    });
    const v = stretta.summary.drcViolations.filter((x) => x.rule === "min_trace_width");
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("0.1mm");
  }, 120_000);

  it("il visore disegna ogni pezzo con la sua larghezza", () => {
    const scena = buildScene(fatta.circuitJson)!;
    const id = String(piste(fatta.circuitJson)[0].pcb_trace_id);
    const mie = scena.traces.filter((t) => t.traceId === id);
    // every polyline of the scene, with the segments it draws
    const disegnati = mie.flatMap((t) =>
      t.points.slice(1).flatMap((b, i) => {
        const a = t.points[i];
        return Math.hypot(b.x - a.x, b.y - a.y) > 1e-9 ? [[r3(a.x), r3(a.y), r3(b.x), r3(b.y), t.width]] : [];
      }),
    );
    expect(disegnati).toEqual([
      [-7.175, 0, -7.175, 2, 0.2],
      [-7.175, 2, 0, 2, 0.6],
      [0, 2, 7.175, 2, 0.2],
      [7.175, 2, 7.175, 0, 0.2],
    ]);
  });

  it("il Gerber disegna ogni tratto con l'apertura della sua larghezza", () => {
    const strati = stringifyGerberCommandLayers(convertSoupToGerberCommands(fatta.circuitJson as never)) as Record<string, string>;
    const top = Object.entries(strati).find(([nome]) => /F_Cu/.test(nome))?.[1] ?? "";
    expect(top).not.toBe("");
    const aperture = new Map<string, number>();
    for (const m of top.matchAll(/%ADD(\d+)C,([\d.]+)\*%/g)) aperture.set(m[1], Number(m[2]));
    const linee: Array<[number, number, number, number, number]> = [];
    let d = 0;
    let qui: [number, number] = [0, 0];
    for (const riga of top.split("\n")) {
      const scelta = /^D(\d+)\*$/.exec(riga.trim());
      if (scelta && Number(scelta[1]) >= 10) d = aperture.get(scelta[1]) ?? NaN;
      const mossa = /^X(-?\d+)Y(-?\d+)D0([12])\*$/.exec(riga.trim());
      if (!mossa) continue;
      const p: [number, number] = [r3(Number(mossa[1]) / 1e6), r3(Number(mossa[2]) / 1e6)];
      if (mossa[3] === "1" && (p[0] !== qui[0] || p[1] !== qui[1])) linee.push([...qui, ...p, d]);
      qui = p;
    }
    expect(linee).toEqual(
      expect.arrayContaining([
        [-7.175, 0, -7.175, 2, 0.2],
        [-7.175, 2, 0, 2, 0.6],
        [0, 2, 7.175, 2, 0.2],
        [7.175, 2, 7.175, 0, 0.2],
      ]),
    );
    // and no copper of this trace drawn at another width
    expect(linee.filter((l) => l[1] === 2 && l[3] === 2)).toEqual([
      [-7.175, 2, 0, 2, 0.6],
      [0, 2, 7.175, 2, 0.2],
    ]);
  });

  it("Sposta la prende come le altre (dal 16/11/2026): il bersaglio di ogni tratto e' largo quanto il suo rame", () => {
    const id = String(piste(fatta.circuitJson)[0].pcb_trace_id);
    const prese = preseDelRame(fatta.circuitJson).filter((b) => b.tipo === "tratto" && b.pcbTraceId === id);
    expect(prese.length).toBeGreaterThan(0);
    // what holds a stretch is its geometry (a pad at its end, a neighbour on its line), never its width
    for (const b of prese) expect(b.fermo ?? "").not.toContain("cambia larghezza");
    // the target of each stretch is as wide as its copper, not as the widest stretch
    expect(
      prese.map((b) => (b.tipo === "tratto" ? [r3(b.x1), r3(b.y1), r3(b.x2), r3(b.y2), b.width] : null)),
    ).toEqual(
      expect.arrayContaining([
        [-7.175, 2, 0, 2, 0.6],
        [0, 2, 7.175, 2, 0.2],
      ]),
    );
    const presa = prese.find((b) => b.tipo === "tratto" && r3(b.y1) === 2 && r3(b.y2) === 2)!;
    if (presa.tipo !== "tratto") throw new Error("non e' un tratto");
    const esito = iniziaGesto({
      circuitJson: fatta.circuitJson,
      regole: resolveDesignRules({}).rules,
      presa: { tipo: "tratto", pcbTraceId: id, indice: presa.indice },
    });
    const detto = "rifiuto" in esito ? esito.rifiuto : JSON.stringify(esito.stato);
    expect(detto).not.toContain("cambia larghezza");
  });
});

describe("una pista senza larghezze sui punti", () => {
  it("ha la route di sempre: nessun punto doppio, una larghezza, e una larghezza uguale a thickness non cambia niente", async () => {
    const senza = await compileProject({ "main.tsx": scheda(PISTA(`{ x: 0.825, y: 2 }, { x: 15.175, y: 2 }`)) });
    const uguale = await compileProject({
      "main.tsx": scheda(PISTA(`{ x: 0.825, y: 2, width: 0.2 }, { x: 15.175, y: 2, width: "0.2mm" }`)),
    });
    const route = routeDi(senza.circuitJson);
    expect(route.map((p) => [r3(p.x), r3(p.y), p.width])).toEqual([
      [-7.175, 0, 0.2],
      [-7.175, 2, 0.2],
      [7.175, 2, 0.2],
      [7.175, 0, 0.2],
    ]);
    expect(JSON.stringify(piste(uguale.circuitJson))).toBe(JSON.stringify(piste(senza.circuitJson)));
  }, 120_000);
});

describe("la larghezza sui punti di un pcbPath, nei casi di bordo", () => {
  it("su una via vale dopo la via; sull'ultimo punto di una pista che finisce nel vuoto non scrive niente", async () => {
    const fatta = await compileProject({
      "main.tsx": scheda(
        [
          `<net name="SIG" />`,
          `<trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPathRelativeTo=".R1 > .pin2" thickness="0.2mm" pcbPath={[` +
            `{ x: 0.825, y: 2 }, { x: 0.825, y: 2, via: true, fromLayer: "top", toLayer: "bottom", width: 0.4 }, { x: 0.825, y: 2 }, ` +
            `{ x: 15.175, y: 2 }, { x: 15.175, y: 2, via: true, fromLayer: "bottom", toLayer: "top" }, { x: 15.175, y: 2 }]} />`,
          `<trace from=".R2 > .pin2" to="net.SIG" pcbPathRelativeTo=".R2 > .pin2" thickness="0.2mm" pcbPath={[{ x: 0.825, y: -3, width: 0.5 }]} />`,
        ].join("\n    "),
      ),
    });
    const [via, libera] = piste(fatta.circuitJson).map((t) => t.route as Punto[]);
    expect(via.map((p) => (p.route_type === "via" ? "via" : `${p.layer} ${p.width}`))).toEqual([
      "top 0.2",
      "top 0.2",
      "via",
      "bottom 0.4",
      "bottom 0.4",
      "via",
      "top 0.4",
      "top 0.4",
    ]);
    // the width of the last point has no segment to go to: the route ends there, once
    expect(libera.map((p) => [r3(p.x), r3(p.y), p.width])).toEqual([
      [8.825, 0, 0.2],
      [8.825, -3, 0.2],
    ]);
  }, 120_000);

  it("una larghezza che non e' una misura positiva fino a 10 mm e' un errore della pista: la pista non c'e', non e' larga zero", async () => {
    for (const w of ["-0.3", "0", "11"]) {
      const fatta = await compileProject({ "main.tsx": scheda(PISTA(`{ x: 0.825, y: 2, width: ${w} }, { x: 15.175, y: 2 }`)) });
      expect(JSON.stringify(fatta.summary.errors)).toContain("width must be a positive length, at most 10mm");
      // the only trace of the board is the wrong one: no copper drawn for it at any width
      expect(piste(fatta.circuitJson)).toEqual([]);
      expect((fatta.circuitJson as El[]).some((e) => e.type === "pcb_smtpad")).toBe(true);
    }
  }, 120_000);

  it("dopo un selettore che non si trova la pista non finisce col punto doppio", async () => {
    const fatta = await compileProject({
      "main.tsx": scheda(
        `<net name="SIG" />\n    <trace from=".R2 > .pin2" to="net.SIG" pcbPathRelativeTo=".R2 > .pin2" thickness="0.2mm" pcbPath={[{ x: 0.825, y: -3, width: 0.5 }, ".R9 > .pin1"]} />`,
      ),
    });
    expect(routeDi(fatta.circuitJson).map((p) => [r3(p.x), r3(p.y), p.width])).toEqual([
      [8.825, 0, 0.2],
      [8.825, -3, 0.2],
    ]);
  }, 120_000);
});

describe("una correzione di Sposta fatta prima che i file dessero le larghezze", () => {
  /*
   * La correzione e' rame di una larghezza sola: posata al posto della pista
   * dei file ne cancellerebbe i colli senza dirlo. Sposta non ne fa su una
   * pista che cambia larghezza; una fatta prima che i file la cambiassero
   * resta orfana, e la scheda ha la pista dei file con le sue larghezze.
   */
  it("non si posa: la pista resta quella dei file e la correzione e' detta orfana", async () => {
    const PRIMA = [
      { x: -7.175, y: 0, layer: "top" },
      { x: -7.175, y: 2, layer: "top" },
      { x: 7.175, y: 2, layer: "top" },
      { x: 7.175, y: 0, layer: "top" },
    ];
    const correzione = {
      connection: ".R1 > .pin2 to .R2 > .pin1",
      points: PRIMA.map((p) => (p.y === 2 ? { ...p, y: 3 } : p)),
      width: 0.2,
      replaces: { original: PRIMA, width: 0.2 },
    };
    const files = { "main.tsx": scheda(CON_LARGHEZZE), "manual-edits.json": JSON.stringify({ pcb_routes: [correzione] }) };
    const fatta = await compileProject(files);
    const tutte = piste(fatta.circuitJson);
    expect(tutte).toHaveLength(1);
    expect(tutte[0].manual).toBeUndefined();
    expect(routeDi(fatta.circuitJson).map((p) => p.width)).toContain(0.6);
    expect(fatta.summary.manualEditsOrphans?.pcb_routes.length).toBe(1);
    // the same correction on the trace of one width is laid, as it always was
    const uniforme = await compileProject({ ...files, "main.tsx": scheda(PISTA(`{ x: 0.825, y: 2 }, { x: 15.175, y: 2 }`)) });
    expect(piste(uniforme.circuitJson).some((t) => t.manual === true)).toBe(true);
    expect(uniforme.summary.manualEditsOrphans).toBeUndefined();
  }, 120_000);

  it("e il salvataggio rifiuta una correzione di una larghezza sola su una pista che cambia larghezza, anche fatta a mano", async () => {
    const fatta = await compileProject({ "main.tsx": scheda(CON_LARGHEZZE) });
    const conLarghezze = percorsoDellaPista(piste(fatta.circuitJson)[0]);
    expect(conLarghezze.map((p) => [r3(p.x), r3(p.y), p.width])).toEqual([
      [-7.175, 0, 0.2],
      [-7.175, 2, 0.6],
      [0, 2, 0.2],
      [7.175, 2, 0.2],
      [7.175, 0, 0.2],
    ]);
    // the path without its widths: a correction that does not know the necks
    const original = conLarghezze.map(({ x, y, layer }) => ({ x, y, layer }));
    const esito = verificaRame({
      circuitJson: fatta.circuitJson,
      regole: resolveDesignRules({}).rules,
      correnti: emptyManualEdits(),
      rame: {
        routes: [
          {
            connection: ".R1 > .pin2 to .R2 > .pin1",
            points: original.map((p) => (p.y === 2 ? { ...p, y: 3 } : p)),
            width: 0.2,
            replaces: { original, width: 0.2 },
          },
        ],
        vias: [],
      },
    });
    expect(esito.ok).toBe(false);
  }, 120_000);
});

describe("il DRC misura ogni tratto con la sua larghezza", () => {
  /*
   * Sopra la parte larga (0,6) passa la pista di R3-R4 a y=2,5: la luce e'
   * 0,5 - 0,3 - 0,1 = 0,1 mm, sotto il minimo. Sopra la parte stretta (0,2)
   * passa quella di R5-R6 a y=2,4: 0,4 - 0,1 - 0,1 = 0,2 mm, a posto. Misurata
   * con la larghezza piu' grande sarebbe 0, misurata con la prima tutta la
   * pista a 0,2 la prima luce sarebbe 0,3.
   */
  it("la luce sotto il minimo e' solo dove la pista e' larga", async () => {
    const vicine = [
      `<resistor name="R3" resistance="1k" footprint="0603" pcbX={-6} pcbY={6} />`,
      `<resistor name="R4" resistance="1k" footprint="0603" pcbX={-2} pcbY={6} />`,
      `<resistor name="R5" resistance="1k" footprint="0603" pcbX={2} pcbY={6} />`,
      `<resistor name="R6" resistance="1k" footprint="0603" pcbX={6} pcbY={6} />`,
      `<trace from=".R3 > .pin2" to=".R4 > .pin1" pcbPathRelativeTo=".R3 > .pin2" pcbPath={[{ x: 0.825, y: -3.5 }, { x: 3.175, y: -3.5 }]} thickness="0.2mm" />`,
      `<trace from=".R5 > .pin2" to=".R6 > .pin1" pcbPathRelativeTo=".R5 > .pin2" pcbPath={[{ x: 0.825, y: -3.6 }, { x: 3.175, y: -3.6 }]} thickness="0.2mm" />`,
    ];
    const fatta = await compileProject({ "main.tsx": scheda([CON_LARGHEZZE, ...vicine].join("\n    ")) });
    const luci = fatta.summary.drcViolations.filter((v) => v.rule === "trace_trace_clearance");
    const punti = luci.flatMap((v) => v.points ?? []);
    expect(punti.length).toBeGreaterThan(0);
    // every short gap is over the wide part, none over the narrow one
    for (const p of punti) expect(p.x).toBeLessThan(0.3);
    const messaggi = luci.map((v) => v.message).join(" ");
    expect(messaggi).toContain("0.100mm");
    expect(messaggi).not.toMatch(/0\.(000|200)mm/);
  }, 120_000);
});

describe("le colate si ritagliano attorno alla larghezza vera", () => {
  /*
   * Una colata di massa su tutto il top: la pista parte stretta, quindi il
   * convertitore del risolutore la ritagliava tutta a 0,2 e la colata arrivava
   * troppo vicina alla parte larga. Ora fra il rame della colata e ogni tratto
   * resta la distanza della colata, e vicino ai tratti stretti la colata arriva
   * a quella distanza, non a quella del tratto largo.
   */
  it("distanza giusta dalla parte larga, e la colata arriva fin dove le consente la parte stretta", async () => {
    const fatta = await compileProject({
      "main.tsx": scheda(
        [
          CON_LARGHEZZE,
          `<net name="GND" />`,
          `<trace from=".R1 > .pin1" to="net.GND" />`,
          `<trace from=".R2 > .pin2" to="net.GND" />`,
          `<copperpour layer="top" connectsTo="net.GND" outline={[{x: -14, y: -7}, {x: 14, y: -7}, {x: 14, y: 7}, {x: -14, y: 7}]} />`,
        ].join("\n    "),
      ),
    });
    const regole = resolveDesignRules({}).rules;
    const distanza = regole.pourClearanceMm ?? regole.minClearanceMm;
    const pezzi = (fatta.circuitJson as El[]).filter((e) => e.type === "pcb_copper_pour" && e.layer === "top");
    expect(pezzi.length).toBeGreaterThan(0);
    const lati = pezzi.flatMap((p) => {
      const b = p.brep_shape as { outer_ring: { vertices: Array<{ x: number; y: number }> }; inner_rings?: Array<{ vertices: Array<{ x: number; y: number }> }> };
      return [b.outer_ring.vertices, ...(b.inner_rings ?? []).map((r) => r.vertices)].flatMap((a) => a.map((q, i) => [a[(i + a.length - 1) % a.length], q] as const));
    });
    const dPS = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
      const t = l > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    };
    /** from the edge of the pour to the middle stretch of a horizontal segment at y=2, minus its half width */
    const luce = (x1: number, x2: number, w: number) => {
      let m = Infinity;
      for (let k = 0; k <= 40; k++) {
        const x = x1 + ((x2 - x1) * k) / 40;
        for (const [a, b] of lati) m = Math.min(m, dPS({ x, y: 2 }, a, b));
      }
      return m - w / 2;
    };
    // the wide stretch, away from its two ends, and the narrow one
    expect(luce(-6, -1, 0.6)).toBeGreaterThanOrEqual(distanza - 0.003);
    expect(luce(1, 6, 0.2)).toBeGreaterThanOrEqual(distanza - 0.003);
    expect(luce(1, 6, 0.2)).toBeLessThan(distanza + 0.01);
    // and the checks agree: no pour too close to any stretch, nothing open
    const drc = runDrcChecks(fatta.circuitJson as never, regole);
    expect(drc.filter((v) => v.rule === "pour_clearance")).toEqual([]);
    expect(fatta.summary.poursOverCopper).toBeUndefined();
    expect(fatta.summary.unroutedTotal ?? 0).toBe(0);
  }, 120_000);
});

describe("pisteAUnaLarghezza: le piste come le legge il risolutore delle colate", () => {
  const filo = (x: number, y: number, width: number, extra: Record<string, unknown> = {}) => ({ route_type: "wire", x, y, width, layer: "top", ...extra });

  it("una scheda con piste di una larghezza sola torna lo stesso array", () => {
    const cj = [
      { type: "pcb_trace", pcb_trace_id: "a", route: [filo(0, 0, 0.2), filo(1, 0, 0.2), { route_type: "via", x: 1, y: 0 }, filo(1, 0, 0.4, { layer: "bottom" }), filo(2, 0, 0.4, { layer: "bottom" })] },
      { type: "pcb_smtpad" },
    ];
    expect(pisteAUnaLarghezza(cj as never)).toBe(cj);
  });

  it("taglia la pista dove cambia larghezza, sotto il suo id, e un tratto con due larghezze ai capi va alla piu' larga", () => {
    const cj = [
      { type: "pcb_trace", pcb_trace_id: "a", source_trace_id: "s", route: [filo(0, 0, 0.2, { start_pcb_port_id: "p1" }), filo(1, 0, 0.2), filo(1, 0, 0.6), filo(3, 0, 0.6), filo(4, 0, 0.25, { end_pcb_port_id: "p2" })] },
    ];
    const fuori = pisteAUnaLarghezza(cj as never) as unknown as Array<{ pcb_trace_id: string; source_trace_id: string; route: Punto[] }>;
    expect(fuori.every((t) => t.pcb_trace_id === "a" && t.source_trace_id === "s")).toBe(true);
    expect(fuori.map((t) => t.route.map((p) => [p.x, p.width]))).toEqual([
      [[0, 0.2], [1, 0.2]],
      [[1, 0.6], [3, 0.6]],
      [[3, 0.6], [4, 0.6]],
      [[4, 0.25]],
    ]);
  });
});
