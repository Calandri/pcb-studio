import {
  ALTIUM_LIBRARY_EXTENSIONS,
  ALTIUM_PROJECT_EXTENSIONS,
  altiumExtension,
  type AltiumFile,
  importAltiumFootprints,
  importAltiumLibrary,
  importAltiumProject,
} from "./altium-import";
import { codiciLcsc, importDatasheetsForIdentities } from "./altium-datasheets";
import { resolveDesignRules } from "./design-rules";
import { CHECKS_ENGINE_VERSION } from "./engine-version";
import { saveLibraryComponent } from "./library-store";
import { saveProjectModel } from "./model-store";
import { emptyManualEdits, MANUAL_EDITS_PATH, serializeManualEdits } from "./manual-edits";
import { filesHash, getProject, saveCompileCache, writeProjectFile } from "./project-store";

/**
 * ONE ALTIUM IMPORT, START TO FINISH.
 *
 * Importing a board is eight steps: read the files, write the project, keep the
 * copper, keep the fabrication rules, promote the footprints, read the
 * libraries, fetch the datasheets, compile so that whoever opens the project
 * sees a board instead of a spinner. Doing them by hand means knowing the order
 * and remembering the two that are easy to forget (the copper as manual edits,
 * and the compile at the end).
 *
 * So it is one function, and both callers use it: the HTTP endpoint the browser
 * talks to and the command line script. The second one exists because the first
 * import of a board is never the only one — you find something wrong, you fix
 * the importer, you do it again — and a run that takes one command instead of
 * eight is the difference between fixing it and giving up.
 *
 * It never throws for a step that can be skipped: a datasheet that does not
 * download, a footprint the library refuses, a compile that fails, all end up in
 * the report. The board is already in and it is worth more than its extras.
 */

export interface AltiumImportReport {
  projectId: string | null;
  componenti: number;
  connessioni: number;
  /** copper segments kept verbatim from the file */
  rame: number;
  footprint: number;
  librerie: number;
  datasheet: { scaricati: number; su: number; pagine: number } | null;
  /** components that came back with a supplier code, so the BOM can be ordered */
  codiciLcsc: number;
  /** the 3D meshes of the components, taken from the STEP inside the file */
  modelli3d: number;
  triangoli3d: number;
  /** the board as compiled right after the import */
  compilato: {
    ok: boolean;
    piste: number;
    via: number;
    piani: number;
    errori: number;
    drc: number;
  } | null;
  warnings: string[];
  stats: Record<string, number | undefined>;
}

export interface AltiumImportOptions {
  files: AltiumFile[];
  /** the project to write into: by default a new one, never an existing board */
  projectId?: string;
  /** called after the project row exists, to give it an owner */
  onProjectCreated?: (projectId: string) => Promise<void>;
  conDatasheet?: boolean;
  conFootprint?: boolean;
  /** compile and store the result, so the project opens already drawn */
  compila?: boolean;
  onStep?: (passo: string) => void;
}

const slug = (nome: string): string =>
  nome
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .toLowerCase();

export async function importaAltium({
  files,
  projectId,
  onProjectCreated,
  conDatasheet = true,
  conFootprint = true,
  compila = true,
  onStep,
}: AltiumImportOptions): Promise<AltiumImportReport> {
  const passo = (s: string) => onStep?.(s);
  const ext = (f: AltiumFile) => altiumExtension(f.path) ?? "";
  const libs = files.filter((f) => ALTIUM_LIBRARY_EXTENSIONS.includes(ext(f)));
  const docs = files.filter((f) => ALTIUM_PROJECT_EXTENSIONS.includes(ext(f)));

  const report: AltiumImportReport = {
    projectId: null,
    componenti: 0,
    connessioni: 0,
    rame: 0,
    footprint: 0,
    librerie: 0,
    modelli3d: 0,
    triangoli3d: 0,
    datasheet: null,
    codiciLcsc: 0,
    compilato: null,
    warnings: [],
    stats: {},
  };

  // the libraries first: their footprints are in the library before the board
  // that uses them arrives, which is the order that makes them reusable.
  // `conFootprint` covers these too: whoever asks not to touch the shared
  // library means the whole library, not half of it
  for (const lib of conFootprint ? libs : []) {
    passo(`libreria ${lib.path}`);
    const imported = await importAltiumLibrary(lib).catch((err) => {
      report.warnings.push(`${lib.path}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (!imported) continue;
    report.warnings.push(...imported.warnings);
    for (const c of imported.components) {
      const saved = await saveLibraryComponent({
        name: c.name,
        description: `Footprint dalla libreria Altium ${lib.path} (${c.pads} pad)`,
        code: c.code,
        source: "altium",
        sourceRef: lib.path,
      }).catch((err) => {
        report.warnings.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      if (saved) report.librerie++;
    }
  }

  if (docs.length === 0) return report;

  /*
   * The project name is decided BEFORE reading the board: the address of every 3D
   * mesh contains it, and those addresses are written into the code the reader
   * generates. Deciding it afterwards would mean rewriting main.tsx.
   */
  const base = slug((docs.find((d) => ext(d) === ".pcbdoc") ?? docs[0]).path);
  const id = projectId ?? `altium-${base || "board"}-${Math.random().toString(36).slice(2, 7)}`;
  report.projectId = id;

  passo("leggo la scheda");
  const imported = await importAltiumProject(docs, {
    traceWidthMm: resolveDesignRules({}).rules.targetTraceWidthMm,
    projectId: id,
  });
  report.warnings.push(...imported.warnings);
  report.componenti = imported.components;
  report.connessioni = imported.traces;
  report.rame = imported.routes.length;
  report.stats = imported.stats;

  passo(`scrivo il progetto ${id}`);
  await getProject(id); // creates the project row
  for (const [path, content] of Object.entries(imported.fsMap)) {
    await writeProjectFile(id, path, content);
  }
  /*
   * The copper goes in as manual edits: the geometry Altium drew replaces the
   * router's for those nets, and nothing else changes. Forgetting this step
   * leaves a board with the right parts and no copper.
   */
  await writeProjectFile(
    id,
    MANUAL_EDITS_PATH,
    serializeManualEdits({ ...emptyManualEdits(), pcb_routes: imported.routes }),
  );
  await onProjectCreated?.(id);

  /*
   * The meshes, one row each. They are written before the compile because the GLB
   * the 3D view asks for is built by fetching these addresses: a project whose
   * code points at a mesh that is not there yet would come out without parts.
   */
  for (const m of imported.modelli3d) {
    passo(`modello 3D ${m.nome}`);
    await saveProjectModel({
      projectId: id,
      name: m.nome,
      obj: m.obj,
      triangles: m.triangoli,
    }).catch((err) => {
      report.warnings.push(
        `modello 3D ${m.nome}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    report.modelli3d++;
    report.triangoli3d += m.triangoli;
  }

  if (conFootprint) {
    passo("footprint della scheda");
    /*
     * The footprints of the board become shared components: they are the ones
     * that went to the fab, and they matter most exactly on the parts with no
     * LCSC code, which otherwise have to be drawn by reading a datasheet. The
     * name carries the project so twenty-six footprints from a customer's board
     * do not land on top of somebody else's.
     */
    const prefisso = base
      .split("-")
      .filter(Boolean)
      .map((p) => p[0].toUpperCase() + p.slice(1))
      .join("")
      .slice(0, 16);
    const footprints = await importAltiumFootprints(docs, { prefisso }).catch((err) => {
      report.warnings.push(`footprint: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    for (const c of footprints?.components ?? []) {
      const saved = await saveLibraryComponent({
        name: c.name,
        description: `Footprint importato da ${docs[0].path} (${c.pads} pad)`,
        code: c.code,
        source: "altium",
        sourceRef: docs[0].path,
      }).catch(() => null);
      if (saved) report.footprint++;
    }
  }

  /*
   * THE ORDER CODES, and this is what turns a drawing into something a factory
   * can quote. A board arrives with its manufacturer part numbers and nothing a
   * supplier answers to: every row of the bill of materials said NON ORDINABILE.
   * The search that finds the code was already being run for the datasheets and
   * the code was thrown away, so here it is asked for on purpose and written
   * into the project, where the BOM reads it.
   *
   * It goes in main.tsx and not in a side file because it belongs to the part:
   * `supplierPartNumbers` is a prop like the manufacturer number next to it.
   */
  if (conDatasheet) {
    passo("codici LCSC");
    const codici = await codiciLcsc(imported.identita, (fatti, totale, mpn) =>
      passo(`codice ${fatti + 1}/${totale}: ${mpn}`),
    ).catch(() => new Map<string, string>());
    if (codici.size > 0) {
      const main = imported.fsMap["main.tsx"] ?? "";
      const conCodici = main.replace(
        /<(\w+) name="([^"]+)"/g,
        (tutto, tag: string, nome: string) => {
          const codice = codici.get(nome);
          if (!codice || tag.toLowerCase() === "net") return tutto;
          return `<${tag} name="${nome}" supplierPartNumbers={{ jlcpcb: ["${codice}"] }}`;
        },
      );
      if (conCodici !== main) {
        imported.fsMap["main.tsx"] = conCodici;
        await writeProjectFile(id, "main.tsx", conCodici);
      }
    }
    report.codiciLcsc = codici.size;
  }

  if (conDatasheet) {
    passo("datasheet");
    const sheets = await importDatasheetsForIdentities({
      projectId: id,
      identita: imported.identita,
      onProgress: (fatti, totale, mpn) => passo(`datasheet ${fatti + 1}/${totale}: ${mpn}`),
    }).catch(() => null);
    if (sheets) {
      report.datasheet = {
        scaricati: sheets.scaricati,
        su: sheets.candidati,
        pagine: sheets.pagine,
      };
    }
  }

  if (compila) {
    passo("compilo");
    /*
     * Compiled and stored right away, and WITHOUT routing: the copper is already
     * there, the router has nothing to add, and an import that leaves the
     * project uncompiled makes the first person to open it wait five minutes for
     * something that could have been done here.
     *
     * The imports are dynamic because this module is used by a script too, and
     * the compiler drags in the whole tscircuit runtime: loading it to import a
     * .PcbLib would be paying for nothing.
     */
    const { compileProject } = await import("./compile");
    const { withLibrary } = await import("./agent-tools");
    try {
      const fsMap = await withLibrary(await getProject(id));
      const { summary, circuitJson } = await compileProject(fsMap, { route: false });
      const el = circuitJson as Array<{ type?: string }>;
      const conta = (t: string) => el.filter((e) => e.type === t).length;
      report.compilato = {
        ok: summary.ok,
        piste: conta("pcb_trace"),
        via: conta("pcb_via"),
        piani: conta("pcb_copper_pour"),
        errori: summary.errors.length,
        drc: summary.drcViolations.length,
      };
      await saveCompileCache(
        id,
        filesHash(fsMap),
        circuitJson as unknown[],
        summary,
        CHECKS_ENGINE_VERSION,
      ).catch(() => {});
    } catch (err) {
      report.warnings.push(
        `compilazione: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return report;
}
