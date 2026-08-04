import {
  circuitJsonToProjectFiles,
  type ComponentIdentity,
  footprintJsx,
  portHintsOf,
  risolviNomiRete,
  toPascalCase,
  type El,
} from "./circuit-json-to-project";
import { buildProjectRules, DESIGN_RULES_PATH, serializeDesignRules } from "./design-rules";
import type { Layer, ManualRoute, ManualRoutePoint } from "./manual-routes";
import { modelli3dNativi } from "./altium-3d";
import { schematicaNativa, type FoglioAltium } from "./altium-schematic";
import {
  contornoNativo,
  footprintDaNativo,
  inventario,
  leggiStrati,
  MIL,
  nomiDeiPad,
  nomiDelleReti,
  pianiNativi,
  rameNativo,
  distanzaColataMisurata,
  regoleNative,
  serigrafiaNativa,
  stratiPredefiniti,
  type PianoImportato,
  type Strato,
  type Trasforma,
} from "./altium-layers";

/**
 * Altium import: .PcbDoc / .SchDoc / .PcbLib / .SchLib -> a tscircuit project.
 *
 * Real boards come from Altium, and until now the only way in was a detour:
 * open the file in KiCad, save as a KiCad project, import that. Two manual
 * steps, and the fidelity was KiCad's converter's.
 *
 * `altium-toolkit` reads the native files and hands back CIRCUIT JSON — the
 * same pivot the KiCad import already uses, and the same one the placer, the
 * magnet, the DRC and the router work on. So this is not a parser: it is an
 * adapter between two things that already speak the same language, and the
 * serialization to tscircuit code is the shared one
 * (circuit-json-to-project.ts).
 *
 * What comes in: components with their REAL pad geometry and their positions,
 * the netlist, the copper already routed, and the footprints of the libraries.
 *
 * The copper is imported as MANUAL ROUTES, not as suggestions: a trace that
 * arrives already drawn from Altium must stay exactly where it is, and the
 * router must not redo it. That is what manual-routes.ts is for, and it needs
 * the name of the connection each trace implements — which is why the source
 * traces are read too, not just the copper.
 *
 * Licence note: altium-toolkit is GPL-3.0-or-later, and so is this project.
 */

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const r3 = (v: number): number => Number(v.toFixed(3));

/** the extensions the toolkit can read, in the two families */
export const ALTIUM_PROJECT_EXTENSIONS = [".pcbdoc", ".schdoc", ".prjpcb", ".pcbdwf"];
export const ALTIUM_LIBRARY_EXTENSIONS = [".pcblib", ".schlib", ".intlib"];

export const altiumExtension = (fileName: string): string | null => {
  const m = /\.[a-z0-9]+$/i.exec(fileName);
  return m ? m[0].toLowerCase() : null;
};

export interface AltiumFile {
  path: string;
  data: ArrayBuffer;
}

export interface ImportedAltiumProject {
  fsMap: Record<string, string>;
  /** the component meshes to store: main.tsx already points at them */
  modelli3d: Array<{ nome: string; obj: string; triangoli: number }>;
  /** what each component IS: code, value, maker, datasheet */
  identita: Map<string, ComponentIdentity>;
  /** copper already drawn in Altium, to be kept verbatim */
  routes: ManualRoute[];
  components: number;
  traces: number;
  warnings: string[];
  stats: Record<string, number | undefined>;
}

export interface ImportedAltiumComponent {
  name: string;
  code: string;
  pads: number;
}

/**
 * Parses one file and returns its Circuit JSON plus whatever the toolkit had to
 * say about it. Failures do not throw: a project can have five files and one
 * unreadable, and losing the other four for it would be the wrong trade.
 */
async function parseOne(
  file: AltiumFile,
): Promise<{ model: El[]; native: Record<string, unknown>; warnings: string[] }> {
  const { Parser } = await import("altium-toolkit");
  try {
    const doc = Parser.parse(
      { fileName: file.path, data: file.data },
      /*
       * The NATIVE model too, and this is not a detail: the canonical Circuit
       * JSON carries geometry and nothing else, while what a part IS — value,
       * manufacturer code, maker, datasheet link, supplier codes — lives only in
       * the native tree. Parsing without it means importing a board and throwing
       * away its bill of materials. On BAT_BS: 98 part numbers, 82 datasheet
       * links, 83 manufacturers, all discarded before anyone could see them.
       */
      { worker: false, extensions: ["altium.native-model"] },
    ) as {
      model?: unknown;
      extensions?: { altium?: { native?: Record<string, unknown> } };
      diagnostics?: Array<{ severity?: string; message?: string }>;
    };
    const model = Array.isArray(doc.model) ? (doc.model as El[]) : [];
    const native = doc.extensions?.altium?.native ?? {};
    const warnings = (doc.diagnostics ?? [])
      .filter((d) => d?.severity !== "info")
      .map((d) => `${file.path}: ${String(d?.message ?? "")}`)
      .filter((w) => w.trim().length > 0);
    return { model, native, warnings };
  } catch (err) {
    return {
      model: [],
      native: {},
      warnings: [`${file.path}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * Brings the board to the origin.
 *
 * Altium works in ABSOLUTE workspace coordinates: on the Arduino UNO the board
 * sits centred at (732.5, 724.4) millimetres, which is where its designer
 * happened to draw it on the sheet. tscircuit wants the board centred on (0,0).
 * Without this every part lands seven hundred millimetres off the board and the
 * import looks empty.
 */
function toBoardOrigin(cj: El[]): El[] {
  const board = cj.find((el) => el.type === "pcb_board");
  const c = (board?.center as { x?: number; y?: number } | undefined) ?? {};
  const dx = num(c.x) ?? 0;
  const dy = num(c.y) ?? 0;
  if (dx === 0 && dy === 0) return cj;

  const point = (p: Record<string, unknown>) => {
    const x = num(p.x);
    const y = num(p.y);
    return x !== null && y !== null ? { ...p, x: r3(x - dx), y: r3(y - dy) } : p;
  };
  return cj.map((raw) => {
    const el: El = { ...raw };
    const x = num(el.x);
    const y = num(el.y);
    if (x !== null) el.x = r3(x - dx);
    if (y !== null) el.y = r3(y - dy);
    const centre = el.center as { x?: number; y?: number } | undefined;
    if (centre && num(centre.x) !== null && num(centre.y) !== null) {
      el.center = { x: r3((num(centre.x) ?? 0) - dx), y: r3((num(centre.y) ?? 0) - dy) };
    }
    const route = el.route as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(route)) el.route = route.map(point);
    const outline = el.outline as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(outline)) el.outline = outline.map(point);
    const points = el.points as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(points)) el.points = points.map(point);
    return el;
  });
}

/**
 * The netlist, recovered from the COPPER.
 *
 * A .PcbDoc carries the net on every track and on every pad, but what arrives
 * here has it only on the tracks: the pads know nothing (verified on the
 * Arduino UNO — 1804 source traces, all with a net, none with a port). So the
 * connection is rebuilt the way it physically is: a pad touched by copper of
 * net X IS on net X.
 *
 * It is not a heuristic on a routed board — it is the definition. On a board
 * with unrouted connections those simply do not appear, which is honest: they
 * are not connected on the copper either.
 */
function netsFromCopper(cj: El[]): El[] {
  const TOCCA_MM = 0.05;
  const netOfSourceTrace = new Map<string, string>();
  for (const el of cj) {
    if (el.type !== "source_trace" || !el.source_trace_id) continue;
    const nets = ((el.connected_source_net_ids as unknown[] | undefined) ?? []).map(String);
    if (nets[0]) netOfSourceTrace.set(String(el.source_trace_id), nets[0]);
  }
  if (netOfSourceTrace.size === 0) return cj;

  /** every pad with its box and the source port it belongs to */
  const pads: Array<{ port: string; x: number; y: number; hw: number; hh: number }> = [];
  const sourceOfPcbPort = new Map<string, string>();
  for (const el of cj) {
    if (el.type === "pcb_port" && el.pcb_port_id) {
      sourceOfPcbPort.set(String(el.pcb_port_id), String(el.source_port_id ?? ""));
    }
  }
  for (const el of cj) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    const x = num(el.x);
    const y = num(el.y);
    const port = sourceOfPcbPort.get(String(el.pcb_port_id ?? ""));
    if (x === null || y === null || !port) continue;
    const w =
      num(el.width) ?? num(el.rect_pad_width) ?? num(el.outer_diameter) ?? (num(el.radius) ?? 0) * 2;
    const h =
      num(el.height) ?? num(el.rect_pad_height) ?? num(el.outer_diameter) ?? (num(el.radius) ?? 0) * 2;
    pads.push({ port, x, y, hw: (w || 0.5) / 2, hh: (h || 0.5) / 2 });
  }

  const portsOfNet = new Map<string, Set<string>>();
  for (const el of cj) {
    if (el.type !== "pcb_trace") continue;
    const net = netOfSourceTrace.get(String(el.source_trace_id ?? ""));
    if (!net) continue;
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    for (const p of route) {
      const x = num(p.x);
      const y = num(p.y);
      if (x === null || y === null) continue;
      for (const pad of pads) {
        if (
          Math.abs(pad.x - x) <= pad.hw + TOCCA_MM &&
          Math.abs(pad.y - y) <= pad.hh + TOCCA_MM
        ) {
          const set = portsOfNet.get(net) ?? new Set<string>();
          set.add(pad.port);
          portsOfNet.set(net, set);
        }
      }
    }
  }

  /*
   * One synthetic source trace per net, carrying all its ports: it is the shape
   * the serializer expects, and it comes out as a <net> plus one <trace> per
   * pin — which is how a net with more than two pins is written.
   */
  const sintetiche: El[] = [];
  let n = 0;
  for (const [net, ports] of portsOfNet) {
    if (ports.size < 2) continue;
    sintetiche.push({
      type: "source_trace",
      source_trace_id: `altium_net_trace_${n++}`,
      connected_source_port_ids: [...ports],
      connected_source_net_ids: [net],
    });
  }
  // the original traces stay: they carry the copper, which is imported apart
  return [...cj, ...sintetiche];
}

/**
 * The netlist, read from the PADS — which is where it is written.
 *
 * Every pad in a .PcbDoc carries the index of its net: 310 of the 350 on this
 * board. That is the netlist, stated by the file, including the connections
 * nobody routed. What was here before rebuilt it from the copper instead —
 * "a pad touched by copper of net X is on net X" — which is true but only sees
 * what is already routed, and needs the copper to be read correctly first.
 *
 * The join to the canonical model is by POSITION: the native coordinates are
 * mils, the canonical ones millimetres, and the two agree to the third decimal
 * (measured: dx = -0.000mm on the first pad). A pad is where it is; there is no
 * shared identifier between the two models, and position is not a heuristic
 * here, it is the same number written in two units.
 */
function retiDaiPad(
  pcb: Record<string, unknown>,
  cj: El[],
  strati: Map<number, Strato>,
  /** native mils -> millimetres from the centre of the board */
  t: Trasforma,
): {
  elementi: El[];
  reti: number;
  padAgganciati: number;
  padConRete: number;
  padRigirati: number;
  /** the real face of each pad, by id: the flattened model puts them all on top */
  facce: Map<string, Layer>;
  /**
   * The solder mask opening of each pad, by id.
   *
   * The file states it pad by pad — 0.05mm on 256 of the 350 here, zero on the
   * ones the designer set by hand — and it is what makes a pad look like a pad
   * instead of a rectangle of copper: on the board there is a ring of bare
   * laminate around it, and that ring is the difference between the drawing and
   * the thing.
   */
  margini: Map<string, number>;
  /** the real name of each pad, by pad id, and of its port, by source port id */
  nomiPad: Map<string, string>;
  nomiPorte: Map<string, string>;
  /**
   * The pads that belong to NO component in the file: mounting holes drilled in
   * the board, by position in hundredths of a millimetre. The flat model files
   * them under whatever part happened to be nearest, and there they become pins
   * of a microphone and travel with it.
   */
  liberi: Set<string>;
} {
  const nomi = nomiDelleReti(pcb);
  const nativi = Array.isArray(pcb.pads) ? (pcb.pads as Array<Record<string, unknown>>) : [];

  /** the source port of each pad, by position in millimetres */
  const sourceOfPcbPort = new Map<string, string>();
  for (const el of cj) {
    if (el.type === "pcb_port" && el.pcb_port_id) {
      sourceOfPcbPort.set(String(el.pcb_port_id), String(el.source_port_id ?? ""));
    }
  }
  /** il designator del componente di ogni pad: serve a distinguere due pad coincidenti */
  const nomeDiSource = new Map<string, string>();
  for (const el of cj) {
    if (el.type === "source_component" && el.source_component_id) {
      nomeDiSource.set(String(el.source_component_id), String(el.name ?? ""));
    }
  }
  const compDiPcb = new Map<string, string>();
  for (const el of cj) {
    if (el.type !== "pcb_component" || !el.pcb_component_id) continue;
    compDiPcb.set(
      String(el.pcb_component_id),
      nomeDiSource.get(String(el.source_component_id ?? "")) ?? "",
    );
  }
  const canonici: Array<{ x: number; y: number; port: string; el: El; comp: string }> = [];
  for (const el of cj) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    const x = num(el.x);
    const y = num(el.y);
    const port = sourceOfPcbPort.get(String(el.pcb_port_id ?? ""));
    if (x === null || y === null || !port) continue;
    canonici.push({ x, y, port, el, comp: compDiPcb.get(String(el.pcb_component_id ?? "")) ?? "" });
  }
  /*
   * La chiave e' posizione PIU' componente: due pad possono stare esattamente
   * nello stesso punto (i due fiducial di questa scheda lo fanno) e con la sola
   * posizione il secondo sovrascriveva il primo, che restava senza nome e senza
   * apertura di maschera — un fiducial coperto di verde non lo legge nessuna
   * macchina di montaggio.
   */
  const perChiave = new Map<string, { port: string; el: El }>();
  const chiave = (x: number, y: number, comp: string) =>
    `${comp}|${Math.round(x * 100)},${Math.round(y * 100)}`;
  for (const c of canonici) perChiave.set(chiave(c.x, c.y, c.comp), { port: c.port, el: c.el });

  const portsOfNet = new Map<string, Set<string>>();
  const facce = new Map<string, Layer>();
  const margini = new Map<string, number>();
  const nomiPad = new Map<string, string>();
  const nomiPorte = new Map<string, string>();
  const liberi = new Set<string>();
  const nomiDaiRecord = nomiDeiPad(pcb);
  const perIndiceNativo = indiciDeiComponenti(pcb);
  let agganciati = 0;
  let conRete = 0;
  let rigirati = 0;
  for (const [indice, p] of nativi.entries()) {
    const x = num(p.x);
    const y = num(p.y);
    if (x === null || y === null) continue;
    const mx = x * MIL;
    const my = y * MIL;
    /** il designator del componente di questo pad nativo, quando il file lo dice */
    const suo = num(p.componentIndex);
    const compNativo = suo === null ? "" : (perIndiceNativo.get(suo) ?? "");
    let trovato = perChiave.get(chiave(mx, my, compNativo));
    if (!trovato) {
      // rounding can land two pads either side of a hundredth: the nearest one
      // within five hundredths of a millimetre is the same pad, nothing else is
      let best = 0.05;
      for (const c of canonici) {
        const d = Math.abs(c.x - mx) + Math.abs(c.y - my);
        if (d < best) {
          best = d;
          trovato = { port: c.port, el: c.el };
        }
      }
    }

    /*
     * WHICH FACE THE PAD IS ON. The flattened model says "top" for all 336 of
     * them, including the 137 that the file puts on the bottom: the layer is in
     * the native pad and nowhere else. Without it half the board's pads are
     * rebuilt on the wrong face, where they collide with the parts that were
     * already there.
     */
    const faccia = strati.get(num(p.layerId) ?? -1)?.faccia;
    /*
     * Anche i fori passanti sono pad. La chiave era il solo pcb_smtpad_id, quindi
     * i nove pad con foro di J1 e J2 restavano col numero del contatore: il pin 1
     * del connettore JST si chiamava 202.
     */
    const idPad = trovato
      ? String(trovato.el.pcb_smtpad_id ?? trovato.el.pcb_plated_hole_id ?? "")
      : "";
    if (idPad && faccia && trovato!.el.layer !== faccia) {
      facce.set(idPad, faccia);
      rigirati++;
    }
    /*
     * The pad's own name. Empty ones (a shield pad with no designator: two on
     * this board) keep what they had rather than becoming a nameless port.
     */
    // a pad the file gives to no component: its POSITION is the key, because the
    // flat model may have turned it into a hole with no port to match it by.
    // In board coordinates, which is where the elements are read back.
    if (suo === null) {
      const q = t(x, y);
      liberi.add(`${Math.round(q.x * 100)},${Math.round(q.y * 100)}`);
    }
    const nomePad = (nomiDaiRecord[indice] ?? "").trim();
    if (idPad && nomePad) {
      nomiPad.set(idPad, nomePad);
      if (trovato) nomiPorte.set(trovato.port, nomePad);
    }

    /*
     * The mask opening. A few pads carry the sentinel -99999 (Altium's "no
     * opening at all"), which as a distance would be nonsense: those are left
     * without a margin rather than pushed through as a negative kilometre.
     */
    if (idPad) {
      const esp =
        (num(p.effectiveSolderMaskExpansion) ?? num(p.solderMaskExpansion) ?? 0) * MIL;
      if (esp > 0 && esp < 2) margini.set(idPad, r3(esp));
    }

    const i = num(p.netIndex);
    const net = i === null ? null : nomi.get(i);
    if (!net) continue;
    conRete++;
    if (!trovato) continue;
    agganciati++;
    const set = portsOfNet.get(net) ?? new Set<string>();
    set.add(trovato.port);
    portsOfNet.set(net, set);
  }

  /*
   * One synthetic source trace per net carrying all its ports: the shape the
   * serializer expects, which comes out as a <net> plus one <trace> per pin.
   */
  const elementi: El[] = [];
  let n = 0;
  for (const [net, ports] of portsOfNet) {
    if (ports.size < 2) continue;
    const netId = `altium_net_${safeNetId(net)}`;
    elementi.push({ type: "source_net", source_net_id: netId, name: net });
    elementi.push({
      type: "source_trace",
      source_trace_id: `altium_net_trace_${n++}`,
      connected_source_port_ids: [...ports],
      connected_source_net_ids: [netId],
    });
  }
  return {
    elementi,
    reti: n,
    padAgganciati: agganciati,
    padConRete: conRete,
    padRigirati: rigirati,
    facce,
    margini,
    nomiPad,
    nomiPorte,
    liberi,
  };
}

const safeNetId = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();

/** the units that can appear in a value, written as the description writes them */
const UNITA = /(\d+(?:[.,]\d+)?)\s*(pF|nF|uF|µF|mF|kOhm|MOhm|Ohm|nH|uH|mH|GHz|MHz|kHz)\b/i;

/**
 * The value, in a form that is not garbage.
 *
 * Altium stores its strings in a Windows codepage, and what arrives here is
 * mangled: `0.1 µF` comes out as `0.1 礔` and `-55 °C ~ 125 °C` as `-55癈 ~ 125癈`.
 * With a broken unit the value is worse than missing — written into the project
 * it would become `capacitance="0.1 礔"`, which no compiler and no purchasing
 * department can read.
 *
 * The DESCRIPTION, though, is plain ASCII and carries the same value:
 * "CAP CER 0.1UF 50V X7R 0402". So when the unit is not readable the value is
 * taken from there. On BAT_BS that is 60 components out of 61.
 */
function valorePulito(valore: string | undefined, descrizione: string | undefined): string | undefined {
  const leggibile = valore && !/[^\x20-\x7E\u00B5\u00C5\u03A9]/.test(valore);
  if (leggibile) return valore;
  const m = descrizione ? UNITA.exec(descrizione) : null;
  if (m) return `${m[1].replace(",", ".")}${m[2].replace(/^u/i, "u")}`;
  // neither readable nor recoverable: better nothing than a broken unit
  return undefined;
}

/**
 * The identity of each component, read from the native parameters.
 *
 * Altium keeps under `pcb.components[].parameters` what the fabricator and the
 * next person need: the manufacturer part number, the value with its unit, who
 * makes it, and the link to the datasheet — the real one, chosen by whoever
 * designed the board, not one guessed from a search. On BAT_BS: 98 part numbers
 * out of 98 and 82 datasheet links.
 *
 * The keys are read case-insensitively because Altium spells them however the
 * library author felt like ("Part Number", "PartNumber", "MANUFACTURER").
 */
function identityFromNative(native: Record<string, unknown>): Map<string, ComponentIdentity> {
  const out = new Map<string, ComponentIdentity>();
  const pcb = (native.pcb ?? {}) as { components?: unknown };
  const comps = Array.isArray(pcb.components) ? (pcb.components as Array<Record<string, unknown>>) : [];
  for (const c of comps) {
    const nome = String(c.designator ?? c.name ?? "").trim();
    if (!nome) continue;
    const par = (c.parameters ?? {}) as Record<string, unknown>;
    const cerca = (...chiavi: string[]): string | undefined => {
      for (const k of Object.keys(par)) {
        const norm = k.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (chiavi.some((w) => norm === w)) {
          const v = String(par[k] ?? "").trim();
          if (v) return v;
        }
      }
      return undefined;
    };
    /** the first link whose description says "datasheet" */
    const datasheet = (() => {
      for (const k of Object.keys(par)) {
        if (!/^componentlink\d+description$/i.test(k)) continue;
        if (!/datasheet/i.test(String(par[k] ?? ""))) continue;
        const url = par[k.replace(/description$/i, "url")];
        const v = String(url ?? "").trim();
        if (/^https?:\/\//i.test(v)) return v;
      }
      // "Datasheet Link" e' un parametro come un altro: su questa scheda punta a
      // Mouser ed era l'unico indirizzo che alcuni componenti avessero
      return cerca("datasheet", "datasheeturl", "datasheetlink", "datasheetpdf");
    })();

    /*
     * "No Description Available" e' il modo in cui una libreria dice che non c'e'
     * una descrizione: metterla in distinta e' peggio che lasciare vuoto.
     */
    const grezza = String(c.description ?? "").trim();
    const descrizione =
      grezza && !/^no description available$/i.test(grezza) ? grezza : cerca("description");

    /*
     * IL CODICE DEL PRODUTTORE, quando non c'e' fra i parametri.
     *
     * Altium tiene in `source` il nome della parte di libreria, e nelle librerie
     * fatte bene quel nome E' il codice: il microcontrollore e i due microfoni
     * di questa scheda non hanno nessun parametro col codice, ma hanno
     * source = "STM32U595RJT6Q" e "SPH0641LU4H".
     *
     * Solo per i componenti che vanno in distinta, e solo se somiglia a un
     * codice: "TEST POINT SMD" e "FIDUCIAL" sono nomi di libreria, non codici.
     */
    const daSource = (() => {
      const v = String(c.source ?? "").trim();
      const genere = String(((c.componentKind ?? {}) as Record<string, unknown>).name ?? "");
      if (!v || /no-bom/.test(genere)) return undefined;
      if (/\s/.test(v)) return undefined;
      return /[0-9]/.test(v) && /[A-Za-z]/.test(v) ? v : undefined;
    })();
    const identita: ComponentIdentity = {
      mpn: cerca("partnumber", "manufacturerpartnumber", "mpn") ?? daSource,
      valore: valorePulito(cerca("capacitance", "resistance", "inductance", "value"), descrizione),
      produttore: cerca("manufacturer", "mfr", "mfrname", "manufacturername", "supplier1"),
      descrizione,
      datasheetUrl: datasheet,
      /*
       * The footprint's name as the CAD library calls it: "CAP 0402_1005",
       * "SOT23-5", "LQFP64". The geometry travels inline, so without this the
       * PACKAGE column of the bill of materials says "<footprint> inline" and
       * whoever has to buy the parts learns nothing from it.
       */
      pattern: String(c.pattern ?? "").trim() || undefined,
    };
    if (Object.values(identita).some(Boolean)) out.set(nome, identita);
  }
  return out;
}

const LAYERS: Layer[] = ["top", "bottom", "inner1", "inner2"];
const asLayer = (v: unknown): Layer => {
  const s = String(v ?? "top").toLowerCase();
  return (LAYERS as string[]).includes(s) ? (s as Layer) : "top";
};

/**
 * The copper already drawn, turned into manual routes.
 *
 * Each pcb_trace declares the connection it implements through its
 * source_trace: without that name the route would be geometry with no owner,
 * the router would redo the connection on its own and the board would end up
 * with two copper branches on the same net (see manual-routes.ts).
 */
function copperAsRoutes(cj: El[], defaultWidthMm: number): ManualRoute[] {
  const nameOfSourceTrace = new Map<string, string>();
  const portsOfSourceTrace = new Map<string, string[]>();
  const netOfSourceTrace = new Map<string, string>();
  const nomeDiRete = new Map<string, string>();
  for (const el of cj) {
    if (el.type === "source_net" && el.source_net_id) {
      nomeDiRete.set(String(el.source_net_id), String(el.name ?? ""));
    }
  }
  for (const el of cj) {
    if (el.type !== "source_trace" || !el.source_trace_id) continue;
    const id = String(el.source_trace_id);
    const display = String(el.display_name ?? "");
    if (display) nameOfSourceTrace.set(id, display);
    portsOfSourceTrace.set(
      id,
      ((el.connected_source_port_ids as unknown[] | undefined) ?? []).map(String),
    );
    const reti = ((el.connected_source_net_ids as unknown[] | undefined) ?? []).map(String);
    if (reti[0]) netOfSourceTrace.set(id, reti[0]);
  }
  /** the fallback name, built like the one tscircuit shows: ".R1 > .pin1 to .U2 > .VDD" */
  const compOfSourcePort = new Map<string, string>();
  const nameOfPort = new Map<string, string>();
  const nameOfComponent = new Map<string, string>();
  for (const el of cj) {
    if (el.type === "source_component" && el.source_component_id) {
      nameOfComponent.set(String(el.source_component_id), String(el.name ?? ""));
    }
    if (el.type === "source_port" && el.source_port_id) {
      compOfSourcePort.set(String(el.source_port_id), String(el.source_component_id ?? ""));
      nameOfPort.set(String(el.source_port_id), String(el.name ?? ""));
    }
  }
  const selector = (portId: string): string | null => {
    const comp = nameOfComponent.get(compOfSourcePort.get(portId) ?? "");
    const pin = nameOfPort.get(portId);
    return comp && pin ? `.${comp} > .${pin}` : null;
  };

  const out: ManualRoute[] = [];
  for (const el of cj) {
    if (el.type !== "pcb_trace") continue;
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    const points: ManualRoutePoint[] = [];
    let width = defaultWidthMm;
    for (const p of route) {
      const x = num(p.x);
      const y = num(p.y);
      if (x === null || y === null) continue;
      const w = num(p.width);
      if (w !== null && w > 0) width = w;
      /*
       * A via in the middle of the path is a layer change: the same shape the
       * hand editor produces when you press a layer key while drawing, so the
       * rest of the pipeline needs no special case for it.
       */
      const layer = asLayer(p.route_type === "via" ? p.to_layer : p.layer);
      points.push({ x: r3(x), y: r3(y), layer });
    }
    if (points.length < 2) continue;

    const sourceId = String(el.source_trace_id ?? "");
    /*
     * In a .PcbDoc the copper belongs to a NET, not to a pin pair: that is how
     * it is drawn and that is how it is imported. The route declares the net,
     * and manual-routes replaces the copper of all its connections at once.
     */
    const net = nomeDiRete.get(netOfSourceTrace.get(sourceId) ?? "");
    if (net) {
      out.push({ connection: `net.${net}`, net, points, width: r3(width) });
      continue;
    }
    const declared = nameOfSourceTrace.get(sourceId);
    const ports = (portsOfSourceTrace.get(sourceId) ?? [])
      .map(selector)
      .filter((s): s is string => s !== null);
    const connection = declared ?? (ports.length >= 2 ? `${ports[0]} to ${ports[1]}` : "");
    // copper with no connection is geometry with no owner: it is dropped, and
    // the router redoes that connection. Better a redone trace than a duplicate
    if (!connection) continue;
    out.push({ connection, points, width: r3(width) });
  }
  return out;
}

/**
 * One or more Altium files -> project files plus the copper to keep.
 *
 * More than one file gets merged before serializing: the .PcbDoc carries
 * geometry and positions, the .SchDoc carries the connections, and a component
 * that exists in both must not become two.
 */
export async function importAltiumProject(
  files: AltiumFile[],
  opts: {
    traceWidthMm?: number;
    /**
     * The project the board is going into. It is needed BEFORE writing anything:
     * the 3D models are served per project, so their address is part of the code
     * this function generates. Without it the bodies are skipped and the board
     * comes in without 3D, which is what happens on a footprint-only import.
     */
    projectId?: string;
  } = {},
): Promise<ImportedAltiumProject> {
  const merged: El[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const identita = new Map<string, ComponentIdentity>();
  /*
   * The designators already seen, to merge the same component described by more
   * than one file. The ids are prefixed with the FILE NAME
   * (cj_..._bs_pcbdoc_source_component_c1 against cj_..._mic_schdoc_...), so
   * deduping by id gave 262 components out of 98 with a board plus its seven
   * schematic sheets: C1 counted once per file that mentions it. The designator
   * is what identifies a part on a board — it is why it is printed on the silk.
   */
  const perDesignator = new Map<string, string>();
  /** the native model of the BOARD: the only one that carries layers and nets */
  let scheda: Record<string, unknown> | null = null;
  /**
   * The schematic sheets, in the order the project lists them: they carry no
   * geometry the board does not already have, but they know how the circuit was
   * DRAWN — which block each part belongs to and which side of its symbol each
   * pin comes out of. See altium-schematic.ts.
   */
  const disegni: FoglioAltium[] = [];
  /*
   * THE BOARD IS READ FIRST, whatever order the files were uploaded in.
   *
   * The dedup by designator keeps the FIRST component it sees: with a schematic
   * sheet ahead of the .PcbDoc the winner was the schematic's R1, which has no
   * footprint and no position, and the board arrived with 90 components out of
   * 98 empty and the connections down from 386 to 17. The result must not depend
   * on the order the browser happened to hand the files over in.
   */
  const ordinati = [...files].sort((a, b) => {
    const peso = (f: AltiumFile) => (altiumExtension(f.path) === ".pcbdoc" ? 0 : 1);
    return peso(a) - peso(b) || a.path.localeCompare(b.path);
  });
  /*
   * UNA IMPORTAZIONE, UNA SCHEDA.
   *
   * Un progetto Altium non contiene solo la scheda: contiene il PANNELLO di
   * produzione, le varianti, i coupon di test, e sono tutti .PcbDoc. BIRDY_BS ne
   * ha due — la scheda, 68x52mm con 98 componenti e 2370 piste, e Panel_BS,
   * 88x290mm con quattro fiducial e nient'altro — e prendendoli tutti e due i
   * fiducial del pannello finivano sulla scheda a duecento millimetri dal suo
   * bordo: tre errori di piazzamento e l'instradamento saltato.
   *
   * La scheda e' quella con il rame: si contano piste, pad e componenti e vince
   * la piu' ricca. Le altre vengono dette e lasciate fuori, geometria e
   * componenti compresi.
   */
  const parsati: Array<{
    file: AltiumFile;
    model: El[];
    native: Record<string, unknown>;
  }> = [];
  for (const file of ordinati) {
    const { model, native, warnings: w } = await parseOne(file);
    warnings.push(...w);
    parsati.push({ file, model, native });
  }
  const pesoDiScheda = (n: Record<string, unknown>): number => {
    const pcbNat = (n.pcb ?? null) as Record<string, unknown> | null;
    if (!pcbNat) return -1;
    const conta = (k: string) => (Array.isArray(pcbNat[k]) ? (pcbNat[k] as unknown[]).length : 0);
    return conta("tracks") + conta("pads") + conta("components");
  };
  const documentiPcb = parsati.filter((x) => altiumExtension(x.file.path) === ".pcbdoc");
  const vincitore = documentiPcb
    .slice()
    .sort((a, b) => pesoDiScheda(b.native) - pesoDiScheda(a.native))[0];
  const scartati = documentiPcb.filter((x) => x !== vincitore);
  if (scartati.length > 0) {
    warnings.push(
      `${documentiPcb.length} documenti PCB nel progetto: importato ${vincitore.file.path}, lasciati fuori ${scartati
        .map((x) => x.file.path)
        .join(", ")} (pannelli, varianti o coupon: una importazione e' una scheda)`,
    );
  }

  for (const { file, model, native } of parsati) {
    if (altiumExtension(file.path) === ".pcbdoc" && vincitore && file !== vincitore.file) continue;
    const pcbNat = (native.pcb ?? null) as Record<string, unknown> | null;
    if (!scheda && pcbNat && Array.isArray(pcbNat.tracks) && pcbNat.tracks.length > 0) {
      scheda = pcbNat;
    }
    if (native.schematic) disegni.push({ path: file.path, native });
    for (const [nome, dati] of identityFromNative(native)) {
      const prima = identita.get(nome) ?? {};
      // the first file that says something wins: the PCB comes first and knows
      // the part, the schematic sheets fill in what it left blank
      identita.set(nome, {
        mpn: prima.mpn ?? dati.mpn,
        valore: prima.valore ?? dati.valore,
        produttore: prima.produttore ?? dati.produttore,
        descrizione: prima.descrizione ?? dati.descrizione,
        datasheetUrl: prima.datasheetUrl ?? dati.datasheetUrl,
        pattern: prima.pattern ?? dati.pattern,
      });
    }
    for (const el of model) {
      /*
       * De-duplication by the element's OWN id: `<type>_id`, which every Circuit
       * JSON row carries. Going by whatever id was on hand looked equivalent and
       * was not: the copper segments of one net all share the same
       * `source_trace_id` (they are the same connection), so keying on that threw
       * away 1730 of the 1804 traces on the Arduino UNO and left one stub per
       * net. The lesson is small and general: dedupe by identity, not by
       * belonging.
       */
      /*
       * A component is identified by its DESIGNATOR, across files: R1 in the
       * schematic and R1 on the board are the same resistor. Everything else is
       * deduped by its own id (`<type>_id`) — and by identity, not by belonging:
       * the copper segments of one net share a source_trace_id and keying on
       * that threw away 1730 traces out of 1804.
       */
      if (el.type === "source_component") {
        const nome = String(el.name ?? "").trim();
        if (nome) {
          if (perDesignator.has(nome)) continue;
          perDesignator.set(nome, String(el.source_component_id ?? ""));
        }
      }
      const id = String(el[`${el.type}_id`] ?? "");
      const key = id ? `${el.type}:${id}` : "";
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      merged.push(el);
    }
  }

  /*
   * THE GEOMETRY COMES FROM THE NATIVE MODEL, NOT FROM THE FLATTENED ONE.
   *
   * The canonical Circuit JSON the toolkit hands over has already thrown the
   * layers away: it puts every track on top or bottom, so silkscreen, courtyard
   * and assembly drawing all arrive as copper, the inner layers are lost and the
   * vias never appear at all. Measured on this board: 2333 "traces" of which 870
   * are copper, and 640 vias missing.
   *
   * The native model has all of it, and in the same coordinates: mils times
   * 0.0254 gives exactly the canonical millimetres (verified: 0.000mm apart on
   * the first pad). So the geometry is rebuilt from there, layer by layer, and
   * the canonical model is kept only for what it does well — components, pads
   * and ports.
   */
  const nativo = scheda ? costruisciDaNativo(scheda, merged, opts.traceWidthMm ?? 0.25) : null;
  if (nativo) warnings.push(...nativo.warnings);

  const senzaFantasmi = soloQuelloCheStaSullaScheda(merged, nativo?.nomiDellePorte.values() ?? []);
  warnings.push(...senzaFantasmi.warnings);
  const base = nativo
    ? // the copper of the flattened model goes: it is rebuilt below, on its real
      // layers, and keeping both would draw every trace twice
      senzaFantasmi.elementi.filter((el) => el.type !== "pcb_trace" && el.type !== "pcb_via")
    : senzaFantasmi.elementi;
  const conRete = nativo
    ? [
        // the pads go back on their own face here: the elements the toolkit
        // hands over are frozen, and toBoardOrigin is where the copies are made
        ...toBoardOrigin(base).map((el) => {
          /*
           * THE PIN NUMBERS. The flattened model names every port with a global
           * counter — the first pin of the microcontroller came out as 22 — and
           * the real name is in the file, on the pad. It goes on the pad AND on
           * its port, because the connections are written with the port's name
           * (`.U1 > .1`) and the two must say the same thing.
           */
          if (el.type === "source_port") {
            const nome = nativo.nomiDellePorte.get(String(el.source_port_id ?? ""));
            if (!nome) return el;
            const numero = Number(nome);
            return {
              ...el,
              name: nome,
              ...(Number.isFinite(numero) ? { pin_number: numero } : {}),
            };
          }
          // il foro passante e' un pad come gli altri: senza la sua chiave il
          // pad teneva il nome del contatore mentre la sua porta aveva quello
          // vero, e tscircuit si ritrovava con due porte per lo stesso piedino
          /*
           * A hole that belongs to nobody goes back to belonging to nobody: the
           * three 2.4mm mounting holes of this board were filed inside a
           * microphone's footprint, which made it a nine pin part and would have
           * dragged three holes across the board with it.
           */
          const px = num(el.x);
          const py = num(el.y);
          if (
            el.pcb_component_id &&
            px !== null &&
            py !== null &&
            nativo.padLiberi.has(`${Math.round(px * 100)},${Math.round(py * 100)}`)
          ) {
            const senzaComponente = { ...el };
            delete senzaComponente.pcb_component_id;
            return senzaComponente;
          }
          const id = String(el.pcb_smtpad_id ?? el.pcb_plated_hole_id ?? "");
          const faccia = nativo.facceDeiPad.get(id);
          const margine = nativo.marginiDeiPad.get(id);
          const nome = nativo.nomiDeiPad.get(id);
          return faccia || margine !== undefined || nome
            ? {
                ...el,
                ...(faccia ? { layer: faccia } : {}),
                ...(margine !== undefined ? { soldermask_margin: margine } : {}),
                ...(nome ? { port_hints: [nome] } : {}),
              }
            : el;
        }),
        ...nativo.reti,
        ...nativo.serigrafia,
      ]
    : netsFromCopper(toBoardOrigin(base));

  /*
   * THE 3D BODIES. They come from the same native model as everything else, and
   * the STEP inside the file becomes a mesh here, once. Only when the project is
   * known: the meshes are served per project, so their address is part of the
   * code being generated.
   */
  const tridi = scheda && opts.projectId
    ? await modelli3dNativi(scheda).catch((err) => {
        warnings.push(`modelli 3D: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      })
    : null;
  if (tridi) warnings.push(...tridi.warnings);
  const corpi3d = new Map<
    string,
    { url?: string; scatola?: { larghezza: number; profondita: number; altezza: number }; altezzaMm?: number }
  >();
  for (const c of tridi?.corpi ?? []) {
    if (c.modello) {
      corpi3d.set(c.designator, {
        url: `/api/project/model?projectId=${encodeURIComponent(opts.projectId ?? "")}&name=${encodeURIComponent(c.modello)}`,
        altezzaMm: c.altezzaMm,
      });
    } else if (c.scatola) {
      corpi3d.set(c.designator, { scatola: c.scatola, altezzaMm: c.altezzaMm });
    }
  }

  /*
   * The drawing, read against the components that actually made it onto the
   * board: a sheet placed twice gives its parts a suffix (MIC_1, MIC_2) and only
   * the board knows which copies exist, so the names come from here and never
   * from the sheets.
   */
  const nomiSullaScheda = conRete
    .filter((el) => el.type === "source_component")
    .map((el) => String(el.name ?? "").trim())
    .filter(Boolean);
  const schematica = disegni.length
    ? schematicaNativa(disegni, nomiSullaScheda)
    : undefined;

  const { fsMap, components, traces } = circuitJsonToProjectFiles(conRete, {
    // the ORDERED names: the board is identical whatever order they were
    // uploaded in, and the header must say so too
    origine: `Importato da Altium (${ordinati.map((f) => f.path).join(", ")})`,
    identita,
    strati: nativo?.strati,
    piani: nativo?.piani.map((p) => ({ faccia: p.faccia, net: p.net, contorno: p.contorno })),
    corpi3d: corpi3d.size ? corpi3d : undefined,
    schematica,
  });
  const routes = nativo ? nativo.routes : copperAsRoutes(conRete, opts.traceWidthMm ?? 0.25);
  /*
   * The board's own fabrication rules travel with it: a board drawn to six mil
   * has to be checked against six mil, not against whatever preset the app
   * happens to default to.
   */
  if (nativo?.regole) {
    const { ristrette, planeClearanceMm, ...limiti } = nativo.regole;
    /*
     * Read and said, not applied: see regoleNative. A pour on a signal layer
     * does not use this number, and using it anyway carved 800mm2 off this
     * board's planes.
     */
    if (planeClearanceMm !== undefined) {
      warnings.push(
        `il file chiede ${planeClearanceMm}mm di distanza per i PIANI NEGATIVI (regola PlaneClearance): questa scheda non ne ha, le sue facce di rame sono strati di segnale con delle colate sopra, che usano la distanza generale`,
      );
    }
    if (Object.values(limiti).some((v) => v !== undefined)) {
      fsMap[DESIGN_RULES_PATH] = serializeDesignRules(buildProjectRules("custom", limiti));
    }
    const coppie = Object.entries(limiti.clearanceByPairMm ?? {});
    if (coppie.length > 0) {
      warnings.push(
        `distanze per coppia prese dal file: ${coppie
          .map(([k, v]) => `${k} ${v}mm`)
          .join(", ")} (le eccezioni che il file scrive dentro il predicato, tipo "non i testpoint", non sono espresse: la regola vale per tutti gli oggetti di quel tipo)`,
      );
    }
    for (const r of ristrette ?? []) {
      warnings.push(
        `regola "${r.nome}" (${r.ambito}) chiede ${r.gapMm}mm e non parla di un tipo di oggetto: non e' stata tradotta, il controllo usa il minimo generale`,
      );
    }
  }
  /*
   * The name a route declares must be the name the PROJECT gives that net, and
   * the project resolves collisions: `+3V3` and `-3V3` both clean up to the same
   * identifier and the second one has to be told apart, or the two rails become
   * one net. So the routes are renamed from the SAME model the main.tsx was
   * written from, which is the only way the two can be guaranteed to agree.
   */
  const nomeDiRete = risolviNomiRete(conRete);
  for (const r of routes) {
    // copper that arrives is copper that arrives, whichever path read it
    r.importato = true;
    if (!r.net) continue;
    r.net = nomeDiRete(r.net);
    r.connection = `net.${r.net}`;
  }

  return {
    fsMap,
    modelli3d: (tridi?.modelli ?? []).map((m) => ({
      nome: m.nome,
      obj: m.obj,
      triangoli: m.triangoli,
    })),
    identita,
    routes,
    components,
    traces,
    warnings,
    stats: {
      elementi: conRete.length,
      piste_importate: routes.length,
      con_codice_produttore: [...identita.values()].filter((v) => v.mpn).length,
      con_datasheet: [...identita.values()].filter((v) => v.datasheetUrl).length,
      file: files.length,
      sezioni_schematico: schematica?.sezioni.length,
      simboli_dal_file: schematica
        ? [...schematica.perComponente.values()].filter((v) => v.lati).length
        : undefined,
      ...(nativo?.stats ?? {}),
      corpi_3d: corpi3d.size,
      modelli_3d: tridi?.modelli.length,
      triangoli_3d: tridi?.modelli.reduce((s, m) => s + m.triangoli, 0),
    },
  };
}

/**
 * WHICH COMPONENT EACH INDEX MEANS.
 *
 * Every silkscreen line, arc and text carries a `componentIndex`, and the
 * obvious reading — `components[componentIndex]` — is wrong: `components` comes
 * back sorted by designator (3V3_MCU, 3V3_MIC, C1, C2…) while the index refers to
 * the order the file stores them in (MIC_2, MIC_1, D8…). On this board 97 of the
 * 98 land on a different part: the outline of one component would travel with
 * another, and the `.Designator` placeholder would print somebody else's name.
 *
 * `componentPrimitives` carries the index and the designator TOGETHER, which is
 * the only place the two are stated side by side.
 */
function indiciDeiComponenti(pcb: Record<string, unknown>): Map<number, string> {
  const out = new Map<number, string>();
  const gruppi = Array.isArray(pcb.componentPrimitives)
    ? (pcb.componentPrimitives as Array<Record<string, unknown>>)
    : [];
  for (const g of gruppi) {
    const i = num(g.componentIndex);
    const nome = String(g.designator ?? "").trim();
    if (i !== null && nome) out.set(i, nome);
  }
  if (out.size > 0) return out;
  // older files carry no grouping: the order of `components` is the only thing
  // there is, and it is right often enough to be better than nothing
  const comps = Array.isArray(pcb.components)
    ? (pcb.components as Array<Record<string, unknown>>)
    : [];
  comps.forEach((c, i) => {
    const nome = String(c.designator ?? c.name ?? "").trim();
    if (nome) out.set(i, nome);
  });
  return out;
}

/**
 * Only what is actually ON the board.
 *
 * The schematic sheets bring in more than the parts: sheet symbols, net labels,
 * mounting marks. On BAT_BS that is thirty extra "components" over the ninety-
 * eight real ones — seventeen of them called `1`, `2`, `3`… and five called
 * `Sheet 1`. They have no footprint and no position, so they pile up at the
 * origin, they put 26 missing-footprint errors in the report, and they end up in
 * the bill of materials.
 *
 * A part with no geometry is not on the board. It is left out and its name is
 * said out loud: if a real part is missing from the layout, whoever imports must
 * find that out from the import, not from the fab.
 */
function soloQuelloCheStaSullaScheda(
  cj: El[],
  /**
   * The REAL names of the pads, which at this point the elements do not carry
   * yet: the flattened model still names every port with a counter, and the
   * shield pads of the microSD are called SM1..SM4 only in the file. Without
   * them the check below cannot tell that the `SM1` of the schematic is a pad of
   * J4 and reports it as a missing component.
   */
  nomiVeriDeiPad: Iterable<string> = [],
): { elementi: El[]; warnings: string[] } {
  const conGeometria = new Set<string>();
  for (const el of cj) {
    if (el.type === "pcb_component" && el.source_component_id) {
      conGeometria.add(String(el.source_component_id));
    }
  }
  // no board here: a project made of schematics only keeps everything it has
  if (conGeometria.size === 0) return { elementi: cj, warnings: [] };

  const fuori = new Map<string, string>();
  for (const el of cj) {
    if (el.type !== "source_component" || !el.source_component_id) continue;
    const id = String(el.source_component_id);
    if (!conGeometria.has(id)) fuori.set(id, String(el.name ?? id));
  }
  if (fuori.size === 0) return { elementi: cj, warnings: [] };

  const portiFuori = new Set<string>();
  for (const el of cj) {
    if (el.type !== "source_port" || !el.source_port_id) continue;
    if (fuori.has(String(el.source_component_id ?? ""))) portiFuori.add(String(el.source_port_id));
  }

  const elementi = cj.filter((el) => {
    if (el.type === "source_component") return !fuori.has(String(el.source_component_id ?? ""));
    if (el.type === "source_port") return !portiFuori.has(String(el.source_port_id ?? ""));
    if (el.type === "schematic_component" || el.type === "schematic_port") {
      return (
        !fuori.has(String(el.source_component_id ?? "")) &&
        !portiFuori.has(String(el.source_port_id ?? ""))
      );
    }
    return true;
  });

  /*
   * The real parts among them, and this list has to be RIGHT: whoever imports a
   * board reads "these components seem real and are not there" and goes looking
   * for what broke. On BAT_BS it named seven and all seven were on the board:
   *
   *  - C30, C31, R18 come from a sheet placed twice, so the board calls them
   *    C30_1 and C30_2 — the name on the sheet exists nowhere as such;
   *  - SM1..SM4 are the shield pads of the microSD, drawn on the schematic as
   *    one pin symbols and living on the board as pads of J4.
   *
   * So a name is only reported when the board has nothing that could be it:
   * neither the name itself, nor a numbered copy of it, nor a pad carrying it.
   */
  const suiPad = new Set<string>(nomiVeriDeiPad);
  for (const el of cj) {
    if (el.type !== "source_port") continue;
    if (portiFuori.has(String(el.source_port_id ?? ""))) continue;
    const nome = String(el.name ?? "").trim();
    if (nome) suiPad.add(nome);
  }
  const sullaScheda = new Set<string>();
  for (const el of cj) {
    if (el.type !== "source_component" || fuori.has(String(el.source_component_id ?? ""))) continue;
    const nome = String(el.name ?? "").trim();
    if (nome) sullaScheda.add(nome);
  }
  const esiste = (n: string): boolean =>
    sullaScheda.has(n) ||
    suiPad.has(n) ||
    [...sullaScheda].some((s) => new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_\\d+$`).test(s));
  const nomi = [...fuori.values()].filter((n) => /^[A-Za-z]{1,3}\d+$/.test(n) && !esiste(n));
  const warnings = [
    `${fuori.size} elementi degli schemi non stanno sulla scheda e non sono stati importati` +
      (nomi.length ? `; fra questi ${nomi.length} sembrano componenti veri: ${nomi.join(", ")}` : ""),
  ];
  return { elementi, warnings };
}

/**
 * The board rebuilt from the native model: copper on its own layers, silkscreen
 * as silkscreen, planes as planes, and the netlist read from the pads.
 *
 * Everything that is NOT one of those — paste, solder mask, courtyard, assembly
 * drawing, mechanical outlines — is counted and reported, not imported. Paste and
 * mask because tscircuit derives them from the pads itself, and drawing them
 * again would be a second opinion on a settled question; courtyard and assembly
 * because they are documentation for a person, and importing them as geometry is
 * how they ended up as copper in the first place.
 */
function costruisciDaNativo(
  pcb: Record<string, unknown>,
  merged: El[],
  larghezzaMm: number,
): {
  routes: ManualRoute[];
  reti: El[];
  serigrafia: El[];
  piani: PianoImportato[];
  strati: number;
  /** the fabrication limits the file declares */
  regole: ReturnType<typeof regoleNative>;
  /** the real face of each pad: the flattened model puts every one of them on top */
  facceDeiPad: Map<string, Layer>;
  /** the solder mask opening of each pad, from the file */
  marginiDeiPad: Map<string, number>;
  /** the real pad names, by pad id and by source port id */
  nomiDeiPad: Map<string, string>;
  nomiDellePorte: Map<string, string>;
  /** positions (hundredths of a mm) of the pads the file gives to no component */
  padLiberi: Set<string>;
  warnings: string[];
  stats: Record<string, number | undefined>;
} {
  const warnings: string[] = [];
  const strati = leggiStrati(pcb);

  /*
   * The board's centre, and with it the shift that brings everything to the
   * origin: Altium draws in absolute sheet coordinates (this board sits at
   * 107.7, 49.4 millimetres) and tscircuit wants the board centred on zero. Same
   * shift toBoardOrigin applies to the canonical model, so the two stay aligned
   * to the third decimal.
   */
  const board = merged.find((el) => el.type === "pcb_board");
  const centro = (board?.center as { x?: number; y?: number } | undefined) ?? {};
  const dx = num(centro.x) ?? 0;
  const dy = num(centro.y) ?? 0;
  const t: Trasforma = (xMil, yMil) => ({ x: xMil * MIL - dx, y: yMil * MIL - dy });
  const areaBoard = (num(board?.width) ?? 0) * (num(board?.height) ?? 0);

  /*
   * The routes come out carrying the RAW Altium net name: the caller renames them
   * with the project's own naming, once the project model is complete. Renaming
   * them here would mean guessing that name twice, in two places, and the two
   * guesses drifting apart is exactly the defect this replaces — 124 nets whose
   * copper declared a connection nobody had ever created.
   */
  const rame = rameNativo(pcb, strati, t, larghezzaMm);
  const regole = {
    ...regoleNative(pcb),
    /*
     * The distance the pours of THIS board keep, measured on its own openings:
     * no rule in the file states it, and using the traces' one gives the board
     * five per cent more copper than it has. See distanzaColataMisurata.
     */
    pourClearanceMm: distanzaColataMisurata(pcb, strati),
  };
  const { piani, isolette, parziali, coperte } = pianiNativi(pcb, strati, t, areaBoard);

  /** designator by native component index, and the value to print for .Comment */
  const comps = Array.isArray(pcb.components)
    ? (pcb.components as Array<Record<string, unknown>>)
    : [];
  const perIndice = indiciDeiComponenti(pcb);
  const designatorDi = (i: number): string | undefined => perIndice.get(i);
  const valoreDi = (designator: string): string | undefined => {
    const c = comps.find((x) => String(x.designator ?? "").trim() === designator);
    return c ? String(c.comment ?? c.description ?? "").trim() || undefined : undefined;
  };

  /** which pcb_component each designator is, so silkscreen lands in its footprint */
  const pcbComponentDi = new Map<string, string>();
  const sourceDiNome = new Map<string, string>();
  for (const el of merged) {
    if (el.type === "source_component" && el.source_component_id) {
      sourceDiNome.set(String(el.name ?? ""), String(el.source_component_id));
    }
  }
  for (const el of merged) {
    if (el.type !== "pcb_component" || !el.pcb_component_id) continue;
    for (const [nome, sid] of sourceDiNome) {
      if (sid === String(el.source_component_id ?? "")) {
        pcbComponentDi.set(nome, String(el.pcb_component_id));
      }
    }
  }

  const silk = serigrafiaNativa(pcb, strati, t, designatorDi, valoreDi);
  const serigrafia: El[] = silk.map((s, i) => ({
    ...(s.type === "pcb_silkscreen_path"
      ? {
          type: "pcb_silkscreen_path",
          pcb_silkscreen_path_id: `altium_silk_${i}`,
          route: s.route,
          stroke_width: s.stroke_width,
        }
      : {
          type: "pcb_silkscreen_text",
          pcb_silkscreen_text_id: `altium_silktext_${i}`,
          text: s.text,
          x: s.x,
          y: s.y,
          font_size: s.font_size,
          anchor_alignment: "center",
        }),
    layer: s.layer,
    ...(s.designator && pcbComponentDi.has(s.designator)
      ? { pcb_component_id: pcbComponentDi.get(s.designator) }
      : {}),
  }));

  const reti = retiDaiPad(pcb, merged, strati, t);

  /** how many copper layers the board has: the ones the stack declares */
  const facceRame = new Set<Layer>();
  for (const s of strati.values()) if (s.genere === "rame" && s.faccia) facceRame.add(s.faccia);
  const numeroStrati = facceRame.size >= 3 ? 4 : 2;

  /*
   * What came in and what did not, per layer. An import that does not say what it
   * dropped is an import you cannot check — and this is exactly the code that was
   * silently turning silkscreen into copper.
   */
  const perGenere = new Map<string, number>();
  for (const riga of inventario(pcb, strati)) {
    /*
     * Vias and pads are NOT documentation, whatever layer they are filed under.
     * Altium keeps them on Multi-Layer, which reads as a mechanical layer, and
     * counting them here produced the line "666 mechanical primitives not
     * imported": 640 of those were the vias, which are imported and are on the
     * board, and 14 the through-hole pads. The line was false about 654 of its
     * 666 and it was the first thing anybody read.
     */
    if (riga.tipo === "via" || riga.tipo === "pad") continue;
    perGenere.set(riga.genere, (perGenere.get(riga.genere) ?? 0) + riga.quante);
  }
  for (const [genere, quante] of perGenere) {
    if (genere === "pasta" || genere === "maschera") {
      warnings.push(
        `${quante} primitive di ${genere === "pasta" ? "pasta salda" : "maschera"} non importate: tscircuit le ricava dai pad`,
      );
    }
    if (genere === "courtyard" || genere === "montaggio" || genere === "meccanico") {
      warnings.push(`${quante} primitive di ${genere} non importate: sono disegno, non geometria`);
    }
  }
  /*
   * The partial pours: only the ones big enough to matter are named. An imported
   * board has a couple of dozen copper islands the size of a pad, and listing
   * them one by one would bury the line that counts — this board's PWR layer is
   * a plane split in four, and that is a thing the person importing must know.
   */
  const grandi = parziali.filter((p) => p.copertura >= 0.01);
  for (const p of grandi) {
    warnings.push(
      `rame non importato su ${p.strato} (rete ${p.net}, ${(p.copertura * 100).toFixed(1)}% della scheda): ${p.motivo}`,
    );
  }
  if (parziali.length > grandi.length) {
    const minori = parziali.filter((p) => p.copertura < 0.01);
    const area = minori.reduce((a, p) => a + p.copertura, 0);
    warnings.push(
      `${minori.length} isole di rame minori non importate (${(area * 100).toFixed(1)}% della scheda in tutto)`,
    );
  }
  /*
   * WHAT IT COSTS, in pads and not in square millimetres. Copper left out is not
   * a percentage: it is the pads that were held together by it and now are not,
   * and that is the line whoever imports needs in order to know whether the
   * board they are looking at behaves like the one that was made.
   */
  const appesi = parziali.reduce((a, p) => a + p.pad, 0);
  if (appesi > 0) {
    const perRete = new Map<string, number>();
    for (const p of parziali) {
      if (p.pad > 0) perRete.set(p.net, (perRete.get(p.net) ?? 0) + p.pad);
    }
    const elenco = [...perRete]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([net, n]) => `${net} (${n})`)
      .join(", ");
    warnings.push(
      `${appesi} pad restano senza il rame che li teneva insieme, su ${perRete.size} reti: ${elenco}`,
    );
  }
  if (rame.ponti.length > 0) {
    warnings.push(
      `${rame.ponti.length} net tie: sulla scheda uniscono due reti con un ponte di rame, nel progetto le reti restano distinte (${rame.ponti.map((p) => `${p.da}/${p.a}`).join(", ")})`,
    );
  }
  if (rame.senzaRete > 0) {
    warnings.push(`${rame.senzaRete} primitive di rame senza rete: non importate`);
  }
  const contorno = contornoNativo(pcb, t);

  if (coperte > 0) {
    warnings.push(
      `${coperte} regioni di rame gia' coperte da una colata piu' grande della loro rete: non riscritte`,
    );
  }
  if (isolette.length > 0) {
    warnings.push(
      `${isolette.length} isolette di rame dentro le aperture dei piani, prese con la forma che hanno (${isolette.reduce((n, i) => n + i.agganci, 0)} fra pad e via): il piano viene scavato intorno a loro`,
    );
  }

  return {
    routes: rame.routes,
    reti: reti.elementi,
    serigrafia,
    piani,
    strati: numeroStrati,
    regole,
    facceDeiPad: reti.facce,
    marginiDeiPad: reti.margini,
    nomiDeiPad: reti.nomiPad,
    nomiDellePorte: reti.nomiPorte,
    padLiberi: reti.liberi,
    warnings,
    stats: {
      rame_tracce: rame.tracce,
      rame_archi: rame.archi,
      rame_via: rame.via,
      rame_senza_rete: rame.senzaRete,
      rame_schegge_scartate: rame.scartate,
      serigrafia_elementi: serigrafia.length,
      piani_importati: piani.length,
      reti_dai_pad: reti.reti,
      pad_con_rete: reti.padConRete,
      pad_agganciati: reti.padAgganciati,
      pad_rimessi_sotto: reti.padRigirati,
      pad_con_maschera: reti.margini.size,
      pin_con_nome_vero: reti.nomiPorte.size,
      strati_rame: facceRame.size,
      contorno_vertici: contorno.length,
    },
  };
}

/**
 * The footprints of a BOARD, promoted to reusable library components.
 *
 * Not from the .PcbLib: measured on BAT_BS those hold four footprints in all, two
 * of them used by nobody, and of the two used one declares seven pads while the
 * microphones on the board have six. Name equal does not mean geometry equal, and
 * the geometry that counts is the one that went to the fab.
 *
 * From the .PcbDoc instead come 26 distinct footprints that have been built and
 * work. They matter exactly where the app is weakest: a part without an LCSC code
 * today has to be drawn by the model reading a datasheet, which is the slow path
 * and the one where mistakes happen. With these, a microphone or a microSD
 * connector is one line.
 *
 * One footprint per NAME, not per component: seventeen 0402 capacitors are one
 * footprint, and importing them seventeen times would be seventeen copies of the
 * same rectangle.
 */
export async function importAltiumFootprints(
  files: AltiumFile[],
  opts: { prefisso?: string } = {},
): Promise<{ components: ImportedAltiumComponent[]; warnings: string[] }> {
  const warnings: string[] = [];
  const merged: El[] = [];
  const identita = new Map<string, ComponentIdentity>();
  let scheda: Record<string, unknown> | null = null;
  for (const file of files) {
    const { model, native, warnings: w } = await parseOne(file);
    warnings.push(...w);
    merged.push(...model);
    const pcbNat = (native.pcb ?? null) as Record<string, unknown> | null;
    if (!scheda && pcbNat && Array.isArray(pcbNat.pads) && pcbNat.pads.length > 0) scheda = pcbNat;
    for (const [n, d] of identityFromNative(native)) if (!identita.has(n)) identita.set(n, d);
  }
  const cj = toBoardOrigin(merged);

  /*
   * The outline printed around the part comes along with it. A footprint without
   * silkscreen is half a footprint: whoever reuses it gets pads on a bare board,
   * with nothing saying where pin one is or which way round the part goes. It is
   * in the native model, on the overlay layers, and it is read here the same way
   * the board reads it.
   */
  const silkPerDesignator = new Map<string, El[]>();
  if (scheda) {
    const strati = leggiStrati(scheda);
    const board = merged.find((el) => el.type === "pcb_board");
    const centro = (board?.center as { x?: number; y?: number } | undefined) ?? {};
    const dx = num(centro.x) ?? 0;
    const dy = num(centro.y) ?? 0;
    const perIndice = indiciDeiComponenti(scheda);
    const silk = serigrafiaNativa(
      scheda,
      strati,
      (xMil, yMil) => ({ x: xMil * MIL - dx, y: yMil * MIL - dy }),
      (i) => perIndice.get(i),
      () => undefined,
    );
    for (const [i, sk] of silk.entries()) {
      if (!sk.designator || sk.type !== "pcb_silkscreen_path") continue;
      silkPerDesignator.set(sk.designator, [
        ...(silkPerDesignator.get(sk.designator) ?? []),
        {
          type: "pcb_silkscreen_path",
          pcb_silkscreen_path_id: `fp_silk_${i}`,
          layer: sk.layer,
          route: sk.route,
          stroke_width: sk.stroke_width,
        },
      ]);
    }
  }

  const nomeDi = new Map<string, string>();
  const footprintDi = new Map<string, string>();
  for (const el of cj) {
    if (el.type !== "source_component" || !el.source_component_id) continue;
    nomeDi.set(String(el.source_component_id), String(el.name ?? ""));
    const fp = String(el.footprint ?? "").trim();
    if (fp) footprintDi.set(String(el.source_component_id), fp);
  }

  /** the elements of every component, and which footprint each one uses */
  const perComponente = new Map<string, El[]>();
  for (const el of cj) {
    const owner = String(el.pcb_component_id ?? "");
    if (!owner) continue;
    perComponente.set(owner, [...(perComponente.get(owner) ?? []), el]);
  }

  const visti = new Set<string>();
  const out: ImportedAltiumComponent[] = [];
  for (const el of cj) {
    if (el.type !== "pcb_component") continue;
    const sourceId = String(el.source_component_id ?? "");
    const fpName = footprintDi.get(sourceId);
    if (!fpName || visti.has(fpName)) continue;

    const elements = perComponente.get(String(el.pcb_component_id ?? "")) ?? [];
    const pads = elements.filter(
      (e) => e.type === "pcb_smtpad" || e.type === "pcb_plated_hole" || e.type === "pcb_hole",
    ).length;
    if (pads === 0) continue;
    visti.add(fpName);

    const centro = (el.center as { x?: number; y?: number } | undefined) ?? {};
    const designator = nomeDi.get(sourceId) ?? "";
    const id = identita.get(designator);
    const nome = toPascalCase(`${opts.prefisso ?? ""}${fpName}`);

    const pinNumbers = new Set<string>();
    for (const e of elements) {
      for (const hint of portHintsOf(e)) if (hint) pinNumbers.add(hint);
    }
    const pinLabels = [...pinNumbers]
      .sort((a, b) => (Number(a) || 0) - (Number(b) || 0))
      .map((n, i) => `pin${i + 1}: "${n}"`)
      .join(", ");

    /*
     * A footprint taken from a BOTTOM component is written the way it will be
     * reused: seen from above. Underneath the board it is mirrored, so its
     * geometry has to be un-mirrored here, or the part comes back with its pads
     * swapped left for right the first time somebody places it on the top side.
     */
    const sotto = String(el.layer ?? "top") === "bottom";
    const body = footprintJsx(
      [...elements, ...(silkPerDesignator.get(designator) ?? [])].map((e) =>
        e.type === "pcb_smtpad" ? { ...e, layer: sotto ? "bottom" : "top" } : e,
      ),
      {
        cx: num(centro.x) ?? 0,
        cy: num(centro.y) ?? 0,
        rotationDeg: num(el.rotation) ?? 0,
        sotto,
      },
      "      ",
    );
    const provenienza = [
      `// Importato da Altium: footprint "${fpName}"`,
      id?.mpn ? `// visto su ${designator} (${id.mpn}${id.produttore ? `, ${id.produttore}` : ""})` : `// visto su ${designator}`,
      id?.datasheetUrl ? `// datasheet: ${id.datasheetUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    out.push({
      name: nome,
      pads,
      code: `${provenienza}
export const ${nome} = (props: any) => (
  <chip
    {...props}
    footprint={
      <footprint>
${body}
      </footprint>
    }${pinLabels ? `\n    pinLabels={{ ${pinLabels} }}` : ""}
  />
)
`,
    });
  }
  return { components: out, warnings };
}

/**
 * .PcbLib / .SchLib -> one library component per footprint, with the pads where
 * the file puts them. Same shape as the KiCad footprint import, so the two
 * sources land in the same library and are used the same way.
 *
 * The geometry comes from the NATIVE tree: the canonical model of a library file
 * carries one source_component per footprint and not a single pad, so grouping
 * by pcb_component_id — which is what a board file would need — found nothing,
 * and every .PcbLib import returned zero components without saying a word.
 * Verified on the three libraries of this board: 1, 2 and 1 footprints, with 7,
 * 6 and 14 pads.
 */
export async function importAltiumLibrary(
  file: AltiumFile,
): Promise<{ components: ImportedAltiumComponent[]; warnings: string[] }> {
  const { native, warnings } = await parseOne(file);
  const lib = (native.pcbLibrary ?? {}) as Record<string, unknown>;
  const footprints = Array.isArray(lib.footprints)
    ? (lib.footprints as Array<Record<string, unknown>>)
    : [];
  if (footprints.length === 0) {
    return {
      components: [],
      warnings: [...warnings, `${file.path}: nessun footprint nel file`],
    };
  }

  // a library declares no stack: the legacy layer numbering is the same for all
  const strati = stratiPredefiniti();
  const base = file.path.replace(/\.[^.]+$/, "");
  const components: ImportedAltiumComponent[] = [];
  const visti = new Set<string>();

  for (const [i, fp] of footprints.entries()) {
    const params = (fp.componentParams ?? {}) as Record<string, unknown>;
    const raw =
      String(params.name ?? "").trim() ||
      String(fp.name ?? "").trim() ||
      `${base}_${i + 1}`;
    const name = toPascalCase(raw);
    if (visti.has(name)) continue;

    const elements = footprintDaNativo(fp, strati) as unknown as El[];
    const pads = elements.filter(
      (e) => e.type === "pcb_smtpad" || e.type === "pcb_plated_hole",
    ).length;
    if (pads === 0) continue;
    visti.add(name);

    // a footprint can carry zero-size pads: placeholders Altium keeps and no
    // fab can build. They are left out, and the numbering of the others stays
    const dichiarati = Array.isArray(fp.pads) ? fp.pads.length : pads;
    if (dichiarati > pads) {
      warnings.push(`${file.path}: ${raw}, ${dichiarati - pads} pad senza dimensioni ignorati`);
    }

    const pinLabels = elements
      .flatMap((e) => portHintsOf(e))
      .filter((h) => /^\d+$/.test(h))
      .sort((a, b) => Number(a) - Number(b))
      .map((n) => `pin${n}: "${n}"`)
      .join(", ");

    const descrizione = String(
      (fp.parameters as Record<string, unknown> | undefined)?.DESCRIPTION ?? params.description ?? "",
    ).trim();
    const body = footprintJsx(elements, { cx: 0, cy: 0 }, "      ");
    components.push({
      name,
      pads,
      code: `// Importato da Altium: ${file.path} (${raw})
${descrizione ? `// ${descrizione.replace(/[\r\n]+/g, " ").slice(0, 120)}\n` : ""}// i pad sono numerati nell'ordine del file: la .PcbLib non scrive i nomi dei pin
export const ${name} = (props: any) => (
  <chip
    {...props}
    footprint={
      <footprint>
${body}
      </footprint>
    }${pinLabels ? `\n    pinLabels={{ ${pinLabels} }}` : ""}
  />
)
`,
    });
  }
  return { components, warnings };
}
