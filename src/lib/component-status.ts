/**
 * A CHECKLIST PER COMPONENT: how far along each part is.
 *
 * A board is not done when it compiles. Every part on it has to have been
 * looked at: its footprint compared with the datasheet, the datasheet actually
 * attached, the manufacturer's errata read and judged against THIS circuit, a
 * sentence saying what it does here, and its pins connected. Five things, and
 * on a board of a hundred parts nobody can hold in their head which of them are
 * done.
 *
 * So they are counted, one row per component, and the board says how many are
 * finished. Until they are all green, what is missing is on screen.
 *
 * WHAT GREEN MEANS, and this is the whole point: green is an ACT, not the
 * presence of a file. A footprint always exists; the question is whether
 * anybody compared it with the drawing in the datasheet. The check is green
 * when there is a record of that comparison and the geometry has not changed
 * since. Whoever did it and when travels with it — see component-checks.ts.
 *
 * Yellow is the honest middle: the data is there but the work is not. An
 * imported board arrives with every footprint drawn by the CAD that made the
 * real thing, which is worth a lot and is not a check.
 */

import { analyzeFootprints } from "./footprint-provenance";
import { readComponentMeta } from "./component-meta";

interface El {
  type: string;
  [key: string]: unknown;
}

export type Stato = "verde" | "giallo" | "rosso" | "non-applicabile";

export const VOCI = ["footprint", "datasheet", "errata", "uso", "collegamento"] as const;
export type Voce = (typeof VOCI)[number];

export const NOME_VOCE: Record<Voce, string> = {
  footprint: "Controllo footprint",
  datasheet: "Datasheet collegato",
  errata: "Errata",
  uso: "Uso nel contesto",
  collegamento: "Collegamenti",
};

export interface StatoVoce {
  stato: Stato;
  /** one line: what is missing, or what was done */
  dettaglio: string;
  /** what backs a green: the document, the check, who said it and when */
  prova?: string;
}

export interface RigaComponente {
  nome: string;
  /** the functional block it was drawn in, when the schematic says so */
  sezione: string | null;
  ftype: string | null;
  mpn: string | null;
  package: string | null;
  pin: number;
  voci: Record<Voce, StatoVoce>;
  /** every voice green or not applicable */
  completo: boolean;
}

export interface QuadroComponenti {
  righe: RigaComponente[];
  completi: number;
  totale: number;
  /** how many components sit in each state, voice by voice */
  perVoce: Record<Voce, Record<Stato, number>>;
}

/** a check somebody recorded: see component-checks.ts */
export interface ControlloRegistrato {
  componente: string;
  voce: Voce;
  stato: "fatto" | "non-applicabile";
  nota: string;
  /** the document, page or measurement it rests on */
  fonte?: string;
  /** the geometry it was made against: a check outlives the thing it checked */
  impronta?: string;
  chi: string;
  quando: string;
}

/** a part with no silicon and nothing to buy: it has no datasheet and no errata */
const SENZA_SILICIO = new Set([
  "simple_resistor",
  "simple_capacitor",
  "simple_inductor",
  "simple_fuse",
  "simple_pinheader",
]);

/** designators that are marks on the board, not parts: fiducials, test points, net ties */
const NON_E_UNA_PARTE = /^(fid|tp|test|nt|mp|h)\d*(_\d+)?$/i;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The fingerprint of a component's geometry: how many pads, where, how big.
 * A footprint check is about a shape, and when the shape changes the check is
 * spent — this is what says so.
 */
export function improntaGeometria(circuitJson: El[], componentId: string): string {
  const pezzi: string[] = [];
  for (const el of circuitJson) {
    if (el.pcb_component_id !== componentId) continue;
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole" && el.type !== "pcb_hole") {
      continue;
    }
    const x = num(el.x);
    const y = num(el.y);
    const w = num(el.width) ?? num(el.radius) ?? num(el.hole_diameter) ?? 0;
    const h = num(el.height) ?? num(el.radius) ?? num(el.hole_diameter) ?? 0;
    if (x === null || y === null) continue;
    pezzi.push(`${x.toFixed(3)},${y.toFixed(3)},${w.toFixed(3)},${h.toFixed(3)}`);
  }
  pezzi.sort();
  // a short, stable digest: it only has to change when the geometry does
  let h = 0;
  for (const p of pezzi.join("|")) h = (Math.imul(h, 31) + p.charCodeAt(0)) | 0;
  return `${pezzi.length}:${(h >>> 0).toString(36)}`;
}

export interface IngressoQuadro {
  circuitJson: El[];
  /** the project code: the footprint string and the hand-written notes live there */
  files: Record<string, string>;
  /** MPNs whose datasheet is in the project */
  datasheetPerMpn: Set<string>;
  /** the model-written descriptions, by component */
  descrizioni: Map<string, { role: string; why: string }>;
  /** what somebody has already checked */
  controlli: ControlloRegistrato[];
}

export function quadroDeiComponenti(input: IngressoQuadro): QuadroComponenti {
  const { circuitJson, files, datasheetPerMpn, descrizioni, controlli } = input;

  const provenienza = new Map(
    analyzeFootprints(circuitJson, files).records.map((r) => [r.component, r]),
  );
  const meta = readComponentMeta(files);

  const pcbPerSource = new Map<string, El>();
  for (const el of circuitJson) {
    if (el.type === "pcb_component" && el.source_component_id) {
      pcbPerSource.set(String(el.source_component_id), el);
    }
  }

  /** which pins of each component are connected to something */
  const portiCollegati = new Set<string>();
  for (const el of circuitJson) {
    if (el.type !== "source_trace") continue;
    for (const p of (el.connected_source_port_ids as string[] | undefined) ?? []) {
      portiCollegati.add(String(p));
    }
  }
  const pinPerComponente = new Map<string, { tot: number; liberi: string[] }>();
  for (const el of circuitJson) {
    if (el.type !== "source_port" || !el.source_component_id) continue;
    const k = String(el.source_component_id);
    const v = pinPerComponente.get(k) ?? { tot: 0, liberi: [] };
    v.tot++;
    if (!portiCollegati.has(String(el.source_port_id ?? ""))) {
      v.liberi.push(String(el.name ?? el.pin_number ?? "?"));
    }
    pinPerComponente.set(k, v);
  }

  /** the sections declared in the code: which block a part was drawn in */
  const sezioni = new Map<string, string>();
  for (const contenuto of Object.values(files)) {
    for (const m of contenuto.matchAll(
      /<\w+\s+name="([^"]+)"[^>]*?schSectionName="([^"]+)"/g,
    )) {
      sezioni.set(m[1], m[2]);
    }
  }

  const controlloDi = new Map<string, ControlloRegistrato>();
  for (const c of controlli) controlloDi.set(`${c.componente}|${c.voce}`, c);

  const righe: RigaComponente[] = [];
  for (const el of circuitJson) {
    if (el.type !== "source_component") continue;
    const nome = String(el.name ?? "").trim();
    if (!nome) continue;
    const sourceId = String(el.source_component_id ?? "");
    const pcb = pcbPerSource.get(sourceId);
    const ftype = el.ftype ? String(el.ftype) : null;
    const mpn = el.manufacturer_part_number ? String(el.manufacturer_part_number) : null;
    const prov = provenienza.get(nome);
    const pin = pinPerComponente.get(sourceId) ?? { tot: 0, liberi: [] };
    const impronta = pcb ? improntaGeometria(circuitJson, String(pcb.pcb_component_id)) : "";
    /*
     * A MARK, NOT A PART. The regex is not enough: the five test points of this
     * board are called 3V3_MCU, 3V3_MIC, 3V3_SD, GND and VBAT — the name of the
     * net they touch — and read as parts they ask for a datasheet that does not
     * exist. One pad and no manufacturer code is what a mark looks like.
     */
    const marchio = NON_E_UNA_PARTE.test(nome) || (pin.tot <= 1 && !mpn);

    const registrato = (voce: Voce): ControlloRegistrato | undefined =>
      controlloDi.get(`${nome}|${voce}`);
    const daRegistro = (voce: Voce): StatoVoce | null => {
      const c = registrato(voce);
      if (!c) return null;
      if (c.stato === "non-applicabile") {
        return { stato: "non-applicabile", dettaglio: c.nota, prova: `${c.chi}, ${c.quando}` };
      }
      return {
        stato: "verde",
        dettaglio: c.nota,
        prova: [c.fonte, `${c.chi}, ${c.quando}`].filter(Boolean).join(" — "),
      };
    };

    // --- il footprint
    const footprint = ((): StatoVoce => {
      const c = registrato("footprint");
      if (c && c.stato === "fatto" && c.impronta && c.impronta !== impronta) {
        return {
          stato: "giallo",
          dettaglio: "il footprint e' cambiato dopo il controllo: va rifatto",
          prova: `controllato il ${c.quando} su una geometria diversa`,
        };
      }
      const dalRegistro = daRegistro("footprint");
      if (dalRegistro) return dalRegistro;
      if (prov?.origin === "manufacturer") {
        return {
          stato: "verde",
          dettaglio: "footprint di libreria del produttore",
          prova: prov.footprint,
        };
      }
      if (pin.tot > 0 && prov && /inline/.test(prov.footprint)) {
        return {
          stato: "rosso",
          dettaglio: "geometria senza nome: non si sa quale package sia",
        };
      }
      /*
       * More pins than pads: the part cannot be soldered as drawn. On this board
       * it is the two microphones, 5 pads against 6 and 9 pins, and it is the
       * kind of thing that is invisible until the assembler asks.
       */
      const pad = Number(impronta.split(":")[0] ?? 0);
      if (pin.tot > 0 && pad > 0 && pad !== pin.tot) {
        return {
          stato: "rosso",
          dettaglio: `${pin.tot} piedini ma ${pad} pad: il footprint non regge il componente`,
        };
      }
      return {
        stato: "giallo",
        dettaglio: prov
          ? `geometria dichiarata (${prov.footprint}), mai confrontata col datasheet`
          : "footprint non leggibile dai sorgenti",
      };
    })();

    // --- il datasheet
    const datasheet = ((): StatoVoce => {
      const dalRegistro = daRegistro("datasheet");
      if (dalRegistro) return dalRegistro;
      if (marchio) {
        return { stato: "non-applicabile", dettaglio: "e' un segno sulla scheda, non una parte" };
      }
      if (!mpn) {
        return { stato: "rosso", dettaglio: "senza codice produttore non c'e' niente da allegare" };
      }
      if (datasheetPerMpn.has(mpn)) {
        return { stato: "verde", dettaglio: "datasheet in progetto", prova: mpn };
      }
      return { stato: "rosso", dettaglio: `datasheet di ${mpn} non ancora scaricato` };
    })();

    // --- gli errata
    const errata = ((): StatoVoce => {
      const dalRegistro = daRegistro("errata");
      if (dalRegistro) return dalRegistro;
      if (marchio || (ftype && SENZA_SILICIO.has(ftype))) {
        return { stato: "non-applicabile", dettaglio: "parte senza silicio: non ha errata" };
      }
      if (!mpn) {
        return { stato: "non-applicabile", dettaglio: "senza codice produttore non si cercano" };
      }
      return { stato: "rosso", dettaglio: "errata mai cercati" };
    })();

    // --- a cosa serve qui
    const uso = ((): StatoVoce => {
      const dalRegistro = daRegistro("uso");
      if (dalRegistro) return dalRegistro;
      /*
       * A CATALOGUE LINE IS NOT A REASON. An imported board arrives with the
       * maker's own words on every part — "SPH0641LU4H ULTRASONIC MIC" — and
       * eighty-five of these ninety-eight had one. Taking that as the answer
       * makes the column green without anybody having written why that
       * microphone is on THIS board, which is the only thing being asked.
       *
       * Green is a sentence about this circuit: the one the model writes after
       * reading the pins and the neighbours, or one a person wrote by hand.
       */
      const scritta = descrizioni.get(nome);
      if (scritta?.why) {
        return { stato: "verde", dettaglio: scritta.why.slice(0, 160), prova: scritta.role };
      }
      const diCatalogo = meta.get(nome)?.description;
      if (diCatalogo) {
        return {
          stato: "giallo",
          dettaglio: `c'e' solo la descrizione di catalogo: "${diCatalogo.slice(0, 90)}"`,
        };
      }
      return { stato: "rosso", dettaglio: "nessuno ha scritto cosa fa su questa scheda" };
    })();

    // --- i collegamenti
    const collegamento = ((): StatoVoce => {
      const dalRegistro = daRegistro("collegamento");
      if (pin.tot === 0) {
        return { stato: "non-applicabile", dettaglio: "non ha piedini" };
      }
      if (pin.liberi.length === 0) {
        return { stato: "verde", dettaglio: `tutti i ${pin.tot} piedini collegati` };
      }
      if (dalRegistro) return dalRegistro;
      if (marchio) {
        return { stato: "non-applicabile", dettaglio: "e' un segno sulla scheda, non collega niente" };
      }
      /*
       * Free pins are not a mistake by themselves: a 64 pin microcontroller with
       * thirteen unused ones is normal, and calling it wrong would make the
       * column red on every real board. What is missing is somebody saying "yes,
       * those are NC" — which is a confirmation, so it is yellow.
       */
      return {
        stato: "giallo",
        dettaglio: `${pin.liberi.length} piedini liberi su ${pin.tot}, da confermare come non collegati: ${pin.liberi.slice(0, 6).join(", ")}${pin.liberi.length > 6 ? "..." : ""}`,
      };
    })();

    const voci = { footprint, datasheet, errata, uso, collegamento };
    righe.push({
      nome,
      sezione: sezioni.get(nome) ?? null,
      ftype,
      mpn,
      package: prov?.footprint ?? null,
      pin: pin.tot,
      voci,
      completo: VOCI.every((v) => voci[v].stato === "verde" || voci[v].stato === "non-applicabile"),
    });
  }

  righe.sort((a, b) => {
    const [, pa = "", na = "0"] = /^([A-Za-z_]*)(\d*)/.exec(a.nome) ?? [];
    const [, pb = "", nb = "0"] = /^([A-Za-z_]*)(\d*)/.exec(b.nome) ?? [];
    return pa === pb ? Number(na) - Number(nb) : pa.localeCompare(pb);
  });

  const perVoce = Object.fromEntries(
    VOCI.map((v) => [
      v,
      {
        verde: righe.filter((r) => r.voci[v].stato === "verde").length,
        giallo: righe.filter((r) => r.voci[v].stato === "giallo").length,
        rosso: righe.filter((r) => r.voci[v].stato === "rosso").length,
        "non-applicabile": righe.filter((r) => r.voci[v].stato === "non-applicabile").length,
      },
    ]),
  ) as QuadroComponenti["perVoce"];

  return {
    righe,
    completi: righe.filter((r) => r.completo).length,
    totale: righe.length,
    perVoce,
  };
}
