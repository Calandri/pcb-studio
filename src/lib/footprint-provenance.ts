/**
 * Provenienza dei footprint: da dove viene la geometria dei pad di ogni
 * componente. Gemello di drc.ts (fabbricabilita'), prc.ts (funzionamento) e
 * schematic-quality.ts (leggibilita'); qui si risponde a una domanda che
 * nessuno degli altri fa: quelle misure sono VERE o plausibili?
 *
 * Nasce da un caso reale: due microfoni MEMS con codice LCSC erano dichiarati
 * footprint="soic8". Il DRC passava, il routing pure, e la scheda era
 * inservibile: pad da 1.5x0.6mm a passo 1.27 sotto un componente da 3.5x2.7mm
 * a passo 0.82, e soprattutto nessun foro per la porta acustica. Il footprint
 * vero era scaricabile in un secondo con il codice LCSC gia' scritto nel file.
 *
 * La regola che rende utile il controllo: un componente che HA un codice LCSC
 * e usa un footprint generico e' un difetto, perche' la geometria vera era
 * disponibile e non e' stata usata. Le misure standard dei passivi (0402,
 * 0603...) restano legittime: sono standard veri, non tirati a indovinare.
 */

export type FootprintOrigin =
  /** geometria del produttore (componente di libreria importato da LCSC) */
  | "manufacturer"
  /** geometria scritta esplicitamente nel progetto (footprint inline o parametrico) */
  | "explicit"
  /** misura standard di un passivo: 0603 su una resistenza e' un footprint vero */
  | "standard"
  /** stringa generica: plausibile, non verificata */
  | "generic";

export interface FootprintRecord {
  component: string;
  ftype?: string;
  footprint: string;
  lcsc?: string;
  origin: FootprintOrigin;
}

export interface FootprintIssue {
  rule: "lcsc_ignored" | "chip_as_passive" | "mechanical_unverified";
  severity: "warn" | "fail";
  component: string;
  message: string;
}

export interface FootprintProvenance {
  /** componenti con geometria verificata (produttore o esplicita) */
  verified: number;
  /** componenti con footprint generico non verificato */
  unverified: number;
  records: FootprintRecord[];
  issues: FootprintIssue[];
}

interface El {
  type: string;
  [key: string]: unknown;
}

type Sources = Record<string, string>;

/** misure standard dei passivi: un 0603 su una resistenza E' il footprint vero */
const PASSIVE_SIZES = new Set([
  "01005", "0201", "0402", "0603", "0805", "1206", "1210", "1812", "2010", "2512",
]);

/** ftype dei componenti per cui una misura standard e' sufficiente */
const PASSIVE_FTYPES = new Set([
  "simple_resistor",
  "simple_capacitor",
  "simple_inductor",
  "simple_led",
  "simple_diode",
]);

/** famiglie di package generiche offerte da tscircuit senza dimensioni reali */
const GENERIC_FAMILIES =
  /^(soic|sop|ssop|tssop|msop|qfp|lqfp|tqfp|qfn|dfn|bga|dip|sot23|sot223|sot89|to\d|pinrow|axial|radial|smd)/i;

const MAX_LIST = 40;

export function emptyFootprintProvenance(): FootprintProvenance {
  return { verified: 0, unverified: 0, records: [], issues: [] };
}

/**
 * `sources` serve perche' la stringa footprint scritta dall'autore non finisce
 * nel Circuit JSON: li' resta solo la geometria risultante, che e' plausibile
 * anche quando e' inventata.
 */
export function analyzeFootprints(
  circuitJson: El[],
  sources: Sources = {},
): FootprintProvenance {
  const result = emptyFootprintProvenance();

  const declared = parseSources(sources);
  if (declared.size === 0) return result;

  /** nomi dei componenti di libreria che portano un codice LCSC del produttore */
  const manufacturerLibs = libsWithRealGeometry(sources);

  for (const el of circuitJson) {
    if (el.type !== "source_component") continue;
    const name = String(el.name ?? "");
    const found = declared.get(name);
    if (!found) continue;

    const ftype = el.ftype ? String(el.ftype) : undefined;
    const lcsc = found.lcsc ?? supplierCode(el);
    const origin = classify(found, ftype, manufacturerLibs);

    result.records.push({ component: name, ftype, footprint: found.footprint, lcsc, origin });
    if (origin === "generic") result.unverified += 1;
    else result.verified += 1;

    pushIssues(result.issues, { name, ftype, lcsc, ...found }, origin);
  }

  result.records = result.records.slice(0, MAX_LIST);
  result.issues = result.issues.slice(0, MAX_LIST);
  return result;
}

interface Declared {
  /** stringa footprint, oppure il tag del componente di libreria usato */
  footprint: string;
  /** true quando il footprint e' un elemento <footprint> inline */
  inline: boolean;
  /** true quando il componente e' istanziato da un componente di libreria */
  fromLib: boolean;
  lcsc?: string;
}

function classify(
  found: Declared,
  ftype: string | undefined,
  manufacturerLibs: Set<string>,
): FootprintOrigin {
  if (found.fromLib) {
    return manufacturerLibs.has(found.footprint) ? "manufacturer" : "explicit";
  }
  if (found.inline) return "explicit";
  // "soic8_w5.3mm_p1.27mm": parametrico, quindi con misure dichiarate
  if (/_[wplh][\d.]+mm/i.test(found.footprint)) return "explicit";
  if (PASSIVE_SIZES.has(found.footprint) && ftype && PASSIVE_FTYPES.has(ftype)) {
    return "standard";
  }
  return "generic";
}

function pushIssues(
  issues: FootprintIssue[],
  comp: { name: string; ftype?: string; lcsc?: string; footprint: string },
  origin: FootprintOrigin,
): void {
  if (origin !== "generic") return;

  if (comp.lcsc) {
    issues.push({
      rule: "lcsc_ignored",
      severity: "fail",
      component: comp.name,
      message:
        `${comp.name} ha il codice LCSC ${comp.lcsc} ma usa il footprint generico ` +
        `"${comp.footprint}": la geometria reale dei pad e' scaricabile con ` +
        `import_component_from_lcsc, quella dichiarata e' solo plausibile.`,
    });
    return;
  }

  // un chip non e' mai un passivo a due pad: 0805 su un quarzo o su un
  // pulsante e' una misura presa in prestito, non il package del componente
  if (PASSIVE_SIZES.has(comp.footprint)) {
    issues.push({
      rule: "chip_as_passive",
      severity: "fail",
      component: comp.name,
      message:
        `${comp.name} non e' un passivo ma usa il footprint "${comp.footprint}", che e' ` +
        `una misura da resistenza/condensatore. Serve il package vero: cerca il part con ` +
        `search_parts e importalo, oppure costruiscilo dal datasheet.`,
    });
    return;
  }

  if (GENERIC_FAMILIES.test(comp.footprint)) {
    issues.push({
      rule: "mechanical_unverified",
      severity: "warn",
      component: comp.name,
      message:
        `${comp.name} usa il footprint generico "${comp.footprint}" senza un codice LCSC: ` +
        `le dimensioni non sono verificate. Trova il part reale o ricava la geometria dal ` +
        `datasheet prima di mandare in produzione.`,
    });
  }
}

/** codice LCSC dal Circuit JSON, quando l'autore lo ha dichiarato */
function supplierCode(el: El): string | undefined {
  const supplier = el.supplier_part_numbers as Record<string, unknown> | undefined;
  const jlc = supplier?.jlcpcb;
  return Array.isArray(jlc) && typeof jlc[0] === "string" ? jlc[0] : undefined;
}

/**
 * Legge dai sorgenti la stringa footprint di ogni componente. I file sotto
 * lib/ sono le definizioni dei componenti di libreria, non istanze: si leggono
 * a parte per capire quali portano geometria del produttore.
 */
function parseSources(sources: Sources): Map<string, Declared> {
  const declared = new Map<string, Declared>();

  for (const [path, content] of Object.entries(sources)) {
    if (path.startsWith("lib/") || !path.endsWith(".tsx")) continue;

    // ogni elemento JSX autochiudente o con figli: <tag ... name="X" ... >
    for (const m of content.matchAll(/<([A-Za-z_][\w]*)\s([^>]*?)\/?>/g)) {
      const tag = m[1];
      const body = m[2];
      const name = /name="([\w]+)"/.exec(body)?.[1];
      if (!name) continue;

      const footprint = /footprint="([^"]+)"/.exec(body)?.[1];
      const lcsc = /jlcpcb:\s*\[\s*"([^"]+)"/.exec(body)?.[1];
      // un tag che inizia per maiuscola e' un componente di libreria
      const fromLib = /^[A-Z]/.test(tag);

      if (footprint) {
        declared.set(name, { footprint, inline: false, fromLib: false, lcsc });
      } else if (fromLib) {
        declared.set(name, { footprint: tag, inline: false, fromLib: true, lcsc });
      } else if (/footprint=\{/.test(body)) {
        declared.set(name, { footprint: "<footprint> inline", inline: true, fromLib: false, lcsc });
      }
    }
  }

  return declared;
}

/**
 * Componenti di libreria che portano geometria vera: quelli importati da LCSC
 * citano il codice del produttore e definiscono i pad uno per uno.
 */
function libsWithRealGeometry(sources: Sources): Set<string> {
  const real = new Set<string>();
  for (const [path, content] of Object.entries(sources)) {
    if (!path.startsWith("lib/") || !path.endsWith(".tsx")) continue;
    const name = path.slice(4, -4);
    if (/<smtpad|<platedhole/.test(content) && /\bC\d{4,10}\b/.test(content)) {
      real.add(name);
    }
  }
  return real;
}
