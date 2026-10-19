import { gunzipSync } from "node:zlib";
import {
  ALTIUM_LIBRARY_EXTENSIONS,
  ALTIUM_PROJECT_EXTENSIONS,
  altiumExtension,
} from "@/lib/altium-import";
import { importaAltium } from "@/lib/altium-pipeline";
import {
  claimProject,
  currentViewer,
  projectAccess,
  requireProjectAccess,
  type Viewer,
} from "@/lib/acl";
import { resolveApiToken } from "@/lib/api-tokens";
import { listUserOrganizations } from "@/lib/org-store";
import { createProject, isValidProjectId } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 300;

/*
 * Altium files are BINARY and big: a real .PcbDoc runs from five to thirty
 * megabytes, where a KiCad text file stays under five. The limit here is the
 * one the format needs, not the one inherited from the other importer.
 */
const MAX_FILE_BYTES = 40 * 1024 * 1024;
/*
 * And a ceiling on the whole upload, decompressed. Each file is capped, but a
 * request can carry many of them: a hundred gzipped files of a few kilobytes
 * each, every one inflating to the per-file cap, is four gigabytes in memory.
 * BAT_BS is twelve files and 5.8 MB.
 */
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;
const MAX_FILES = 60;

/**
 * A file may arrive GZIPPED, named `<nome>.gz`.
 *
 * Not an optimisation: a request body on Vercel stops at 4.5 MB, and a real
 * Altium project is more — BAT_BS is 5.8 MB across twelve files and was refused
 * with a 413. The same files gzipped are 2.8 MB, because an OLE container is
 * half air. So whoever uploads may compress, and the name says whether they did.
 *
 * The decompressed size is capped: an upload is untrusted input, and a few
 * kilobytes of zeros expand into gigabytes if nobody is counting.
 */
function scompatta(
  nome: string,
  dati: ArrayBuffer,
  massimo: number = MAX_FILE_BYTES,
): { path: string; data: ArrayBuffer } {
  if (!/\.gz$/i.test(nome)) return { path: nome, data: dati };
  const uscita = gunzipSync(Buffer.from(dati), { maxOutputLength: Math.min(MAX_FILE_BYTES, massimo) });
  return {
    path: nome.replace(/\.gz$/i, ""),
    data: uscita.buffer.slice(uscita.byteOffset, uscita.byteOffset + uscita.byteLength) as ArrayBuffer,
  };
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/** the caller may not write the project: a 403, not a failed import */
class AccessoNegato extends Error {}

/**
 * Altium import: multipart with one or more files.
 *
 * - `.PcbLib` / `.SchLib` / `.IntLib` -> footprints become shared library
 *   components, exactly like the KiCad `.kicad_mod` path;
 * - `.PcbDoc` (with its `.SchDoc`, or a `.PrjPcb`) -> a NEW project
 *   `altium-<name>-<suffix>`, owned by the caller, never overwriting existing
 *   work.
 *
 * The whole chain lives in altium-pipeline.ts, and the command line script runs
 * the same one: an import done from the browser and one done from a terminal
 * must produce the same project, or the second is a different feature that
 * happens to share a name.
 */
export async function POST(req: Request): Promise<Response> {
  /*
   * The browser sends a session, the command line sends a personal token
   * (pcbs_..., the same one the MCP server takes). Two ways in, one import: a
   * board imported from a terminal must be the same board as one imported by
   * dropping the files on the page, and that only holds if there is one
   * implementation behind both.
   */
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const viewer = bearer ? await resolveApiToken(bearer) : await currentViewer();
  if (!viewer) return jsonError("unauthenticated", 401);

  const form = await req.formData().catch(() => null);
  if (!form) return jsonError("multipart form data required", 400);

  const files: Array<{ path: string; data: ArrayBuffer }> = [];
  const entries = form.getAll("file").filter((e): e is File => e instanceof File);
  if (entries.length > MAX_FILES) {
    return jsonError(`troppi file (massimo ${MAX_FILES} per importazione)`, 413);
  }
  let totale = 0;
  for (const entry of entries) {
    if (entry.size > MAX_FILE_BYTES) {
      return jsonError(
        `file "${entry.name}" troppo grande (massimo ${MAX_FILE_BYTES / 1024 / 1024}MB)`,
        413,
      );
    }
    const troppo = () =>
      jsonError(
        `importazione troppo grande: piu' di ${MAX_TOTAL_BYTES / 1024 / 1024}MB in tutto una volta decompressa`,
        413,
      );
    const resto = MAX_TOTAL_BYTES - totale;
    if (resto <= 0) return troppo();
    try {
      const file = scompatta(entry.name, await entry.arrayBuffer(), resto);
      totale += file.data.byteLength;
      if (totale > MAX_TOTAL_BYTES) return troppo();
      files.push(file);
    } catch (err) {
      // the inflater stops at the cap with a RangeError: that is "too big", not "unreadable"
      if (err instanceof RangeError || (err as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE") {
        return jsonError(`file "${entry.name}" troppo grande una volta decompresso`, 413);
      }
      return jsonError(
        `file "${entry.name}" illeggibile: ${err instanceof Error ? err.message : String(err)}`,
        400,
      );
    }
  }
  if (files.length === 0) return jsonError("nessun file caricato", 400);

  const ext = (f: { path: string }) => altiumExtension(f.path) ?? "";
  const accettati = [...ALTIUM_PROJECT_EXTENSIONS, ...ALTIUM_LIBRARY_EXTENSIONS];
  if (files.some((f) => !accettati.includes(ext(f)))) {
    return jsonError(`si accettano solo ${accettati.join(", ")}`, 400);
  }

  /*
   * Re-importing INTO an existing project is asked for explicitly and only by
   * someone who can already write to it. It is the step you take after fixing
   * something in the importer, and without it the only way forward is a new
   * project every time and a list of near-identical boards nobody can tell apart.
   */
  const richiesto = form.get("projectId");
  const projectId = typeof richiesto === "string" && richiesto.trim() ? richiesto.trim() : undefined;
  if (projectId && !isValidProjectId(projectId)) {
    return jsonError("identificativo di progetto non valido", 400);
  }

  const orgs = await listUserOrganizations(viewer.userId).catch(() => []);
  const orgId = orgs[0]?.id ?? null;
  /*
   * An explicit project is CLAIMED first: created in the caller's name if it
   * does not exist, left alone if it does. Then the access check runs on the
   * row that is really there — so a project somebody else created a moment ago
   * is refused, and re-importing over an existing board (which overwrites its
   * main.tsx and its manual edits) needs edit rights on it.
   */
  const assicuraScrittura = async (id: string, chi: Viewer): Promise<void> => {
    await claimProject(id, chi, orgId);
    if ((await projectAccess(id, chi)) !== "edit") {
      throw new AccessoNegato(`nessun permesso di scrittura su ${id}`);
    }
  };
  if (projectId) {
    try {
      await assicuraScrittura(projectId, viewer);
    } catch (err) {
      if (err instanceof AccessoNegato) return jsonError(err.message, 403);
      throw err;
    }
  }

  /*
   * The three steps you can leave out. They all cost minutes and none of them is
   * the board: the datasheets fetch from the internet, the footprints write to
   * the shared library, the compile runs the whole tscircuit pipeline. Re-running
   * an import to check one change should not have to pay for the other three.
   */
  const senza = (campo: string) => form.get(campo) !== null;

  try {
    const report = await importaAltium({
      files,
      projectId,
      conDatasheet: !senza("senzaDatasheet"),
      conFootprint: !senza("senzaFootprint"),
      compila: !senza("senzaCompilare"),
      preparaProgetto: async (id, nuovo) => {
        if (!nuovo) return assicuraScrittura(id, viewer);
        /*
         * A generated id must be a NEW project: if the random suffix ever
         * lands on an existing one, that is somebody's board, and the import
         * stops instead of writing over it.
         */
        const creato = await createProject(id, {
          userId: viewer.userId,
          orgId,
          name: null,
        });
        if (!creato) throw new Error(`il progetto ${id} esiste gia': ripeti l'importazione`);
      },
    });

    if (report.projectId === null && report.librerie === 0) {
      return jsonError("niente da importare: carica un .PcbDoc o un .PcbLib", 400);
    }

    // what could not be read is said out loud: an import that hides what it
    // lost is worse than one that fails
    return Response.json({
      project: report.projectId
        ? {
            id: report.projectId,
            components: report.componenti,
            traces: report.connessioni,
            routes: report.rame,
            footprints: report.footprint,
            datasheets: report.datasheet,
            compiled: report.compilato,
          }
        : null,
      components: report.librerie,
      stats: report.stats,
      warnings: report.warnings.slice(0, 50),
    });
  } catch (err) {
    if (err instanceof AccessoNegato) return jsonError(err.message, 403);
    return jsonError(
      `import da Altium fallito: ${err instanceof Error ? err.message : String(err)}`,
      422,
    );
  }
}

/** what this endpoint accepts, for whoever builds the upload form */
export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return jsonError("forbidden", 403);
  return Response.json({
    progetto: ALTIUM_PROJECT_EXTENSIONS,
    libreria: ALTIUM_LIBRARY_EXTENSIONS,
    note: "il rame gia' instradato viene conservato come percorsi manuali: non viene rifatto",
  });
}
