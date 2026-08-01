/**
 * Footprint provenance: where the pad geometry of each component comes from.
 * Twin of drc.ts (manufacturability), prc.ts (operation) and
 * schematic-quality.ts (readability); here we answer a question none of the
 * others asks: are those measurements REAL or plausible?
 *
 * Born from a real case: two MEMS microphones with an LCSC code were declared
 * as footprint="soic8". The DRC passed, the routing too, and the board was
 * unusable: 1.5x0.6mm pads at 1.27 pitch under a 3.5x2.7mm component at
 * 0.82 pitch, and above all no hole for the acoustic port. The real footprint
 * was downloadable in a second with the LCSC code already written in the file.
 *
 * The rule that makes the check useful: a component that HAS an LCSC code and
 * uses a generic footprint is a defect, because the real geometry was
 * available and was not used. The standard sizes of passives (0402, 0603...)
 * remain legitimate: they are real standards, not guessed.
 */

export type FootprintOrigin =
  /** manufacturer geometry (library component imported from LCSC) */
  | "manufacturer"
  /** geometry written explicitly in the project (inline or parametric footprint) */
  | "explicit"
  /** standard size of a passive: 0603 on a resistor is a real footprint */
  | "standard"
  /** generic string: plausible, not verified */
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
  /** components with verified geometry (manufacturer or explicit) */
  verified: number;
  /** components with an unverified generic footprint */
  unverified: number;
  records: FootprintRecord[];
  issues: FootprintIssue[];
}

interface El {
  type: string;
  [key: string]: unknown;
}

type Sources = Record<string, string>;

/** standard sizes of passives: a 0603 on a resistor IS the real footprint */
const PASSIVE_SIZES = new Set([
  "01005", "0201", "0402", "0603", "0805", "1206", "1210", "1812", "2010", "2512",
]);

/** ftypes of components for which a standard size is sufficient */
const PASSIVE_FTYPES = new Set([
  "simple_resistor",
  "simple_capacitor",
  "simple_inductor",
  "simple_led",
  "simple_diode",
]);

/** generic package families offered by tscircuit without real dimensions */
const GENERIC_FAMILIES =
  /^(soic|sop|ssop|tssop|msop|qfp|lqfp|tqfp|qfn|dfn|bga|dip|sot23|sot223|sot89|to\d|pinrow|axial|radial|smd)/i;

const MAX_LIST = 40;

export function emptyFootprintProvenance(): FootprintProvenance {
  return { verified: 0, unverified: 0, records: [], issues: [] };
}

/**
 * `sources` is needed because the footprint string written by the author does
 * not end up in the Circuit JSON: there only the resulting geometry remains,
 * which is plausible even when it is made up.
 */
export function analyzeFootprints(
  circuitJson: El[],
  sources: Sources = {},
): FootprintProvenance {
  const result = emptyFootprintProvenance();

  const declared = parseSources(sources);
  if (declared.size === 0) return result;

  /** names of library components that carry a manufacturer LCSC code */
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

  // records are not truncated: they are one row per component and are needed
  // in full for the bill of materials, where a component without a package
  // cannot be ordered
  result.issues = result.issues.slice(0, MAX_LIST);
  return result;
}

interface Declared {
  /** footprint string, or the tag of the library component used */
  footprint: string;
  /** true when the footprint is an inline <footprint> element */
  inline: boolean;
  /** true when the component is instantiated from a library component */
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
  // "soic8_w5.3mm_p1.27mm": parametric, therefore with declared dimensions
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

  // a chip is never a two-pad passive: 0805 on a crystal or a button is a
  // borrowed size, not the component's package
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

/** LCSC code from the Circuit JSON, when the author declared it */
function supplierCode(el: El): string | undefined {
  const supplier = el.supplier_part_numbers as Record<string, unknown> | undefined;
  const jlc = supplier?.jlcpcb;
  return Array.isArray(jlc) && typeof jlc[0] === "string" ? jlc[0] : undefined;
}

/**
 * Reads the footprint string of each component from the sources. The files
 * under lib/ are the definitions of library components, not instances: they
 * are read separately to find out which ones carry manufacturer geometry.
 */
function parseSources(sources: Sources): Map<string, Declared> {
  const declared = new Map<string, Declared>();

  for (const [path, content] of Object.entries(sources)) {
    if (path.startsWith("lib/") || !path.endsWith(".tsx")) continue;

    // every self-closing JSX element or one with children: <tag ... name="X" ... >
    for (const m of content.matchAll(/<([A-Za-z_][\w]*)\s([^>]*?)\/?>/g)) {
      const tag = m[1];
      const body = m[2];
      const name = /name="([\w]+)"/.exec(body)?.[1];
      if (!name) continue;

      const footprint = /footprint="([^"]+)"/.exec(body)?.[1];
      const lcsc = /jlcpcb:\s*\[\s*"([^"]+)"/.exec(body)?.[1];
      // a tag starting with a capital letter is a library component
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
 * Library components that carry real geometry: those imported from LCSC cite
 * the manufacturer code and define the pads one by one.
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
