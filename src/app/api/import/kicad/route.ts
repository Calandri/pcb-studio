import { importKicadFootprint, importKicadProject } from "@/lib/kicad-import";
import { currentViewer, requireProjectAccess } from "@/lib/acl";
import { listUserOrganizations } from "@/lib/org-store";
import { saveLibraryComponent } from "@/lib/library-store";
import { createProject, writeProjectFile } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** a project is a board and its sheets, a library a handful of footprints */
const MAX_FILES = 40;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/**
 * KiCad import (Fase 3.g). Multipart with one or more files:
 * - a .kicad_mod file -> footprint becomes a shared library component
 * - a .kicad_pcb (optionally with its .kicad_sch) -> becomes a NEW project
 *   (kicad-<name>-<suffix>) owned by the caller, never overwrites existing work
 *
 * Altium files have their own endpoint: /api/import/altium.
 */
export async function POST(req: Request): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return jsonError("unauthenticated", 401);

  const form = await req.formData().catch(() => null);
  if (!form) return jsonError("multipart form data required", 400);

  const files: Array<{ path: string; content: string }> = [];
  const entries = form.getAll("file").filter((e): e is File => e instanceof File);
  if (entries.length > MAX_FILES) return jsonError(`too many files (max ${MAX_FILES})`, 413);
  let total = 0;
  for (const entry of entries) {
    if (entry.size > MAX_FILE_BYTES) {
      return jsonError(`file "${entry.name}" too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB)`, 413);
    }
    total += entry.size;
    if (total > MAX_TOTAL_BYTES) {
      return jsonError(`upload too large (max ${MAX_TOTAL_BYTES / 1024 / 1024}MB in total)`, 413);
    }
    files.push({ path: entry.name, content: await entry.text() });
  }
  if (files.length === 0) return jsonError("no files uploaded", 400);

  const byExt = (ext: RegExp) => files.filter((f) => ext.test(f.path));
  const mods = byExt(/\.kicad_mod$/i);
  const pcbs = byExt(/\.kicad_pcb$/i);
  const schs = byExt(/\.kicad_sch$/i);
  if (mods.length + pcbs.length + schs.length !== files.length) {
    return jsonError("only .kicad_mod, .kicad_pcb and .kicad_sch files are accepted", 400);
  }
  if (pcbs.length > 1) return jsonError("upload one .kicad_pcb at a time", 400);

  try {
    // footprint(s) -> library components
    const components: Array<{ name: string; version: number }> = [];
    for (const mod of mods) {
      const imported = await importKicadFootprint(mod.path, mod.content);
      const saved = await saveLibraryComponent({
        name: imported.name,
        description: `Imported from KiCad footprint ${mod.path}`,
        code: imported.code,
        source: "kicad",
        sourceRef: mod.path,
      });
      components.push({ name: imported.name, version: saved.version });
    }

    // pcb (+sch) -> new project
    let project: {
      id: string;
      components: number;
      traces: number;
      warnings: string[];
    } | null = null;
    if (pcbs.length === 1) {
      const imported = importKicadProject([...pcbs, ...schs]);
      const base = pcbs[0].path
        .replace(/\.kicad_pcb$/i, "")
        .replace(/[^A-Za-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .toLowerCase();
      /*
       * The project is CREATED, with its owner, before a single file is
       * written: reading no longer creates rows, and writing into a project
       * that does not exist fails. A new id is never an existing project — if
       * the random suffix ever lands on one, another suffix is drawn instead of
       * writing over somebody's board.
       */
      const orgs = await listUserOrganizations(viewer.userId);
      let projectId: string | null = null;
      for (let tentativo = 0; tentativo < 5 && !projectId; tentativo++) {
        const candidato = `kicad-${base || "board"}-${Math.random().toString(36).slice(2, 7)}`;
        const creato = await createProject(candidato, {
          userId: viewer.userId,
          orgId: orgs[0]?.id ?? null,
          name: pcbs[0].path.replace(/\.kicad_pcb$/i, "").slice(0, 120) || null,
        });
        if (creato) projectId = candidato;
      }
      if (!projectId) return jsonError("could not allocate a project id, try again", 503);
      for (const [path, content] of Object.entries(imported.fsMap)) {
        await writeProjectFile(projectId, path, content);
      }
      project = {
        id: projectId,
        components: imported.components,
        traces: imported.traces,
        warnings: imported.warnings.map(String).slice(0, 50),
      };
    }

    if (components.length === 0 && !project) {
      return jsonError("nothing to import: provide a .kicad_mod or a .kicad_pcb", 400);
    }

    return Response.json({ components, project });
  } catch (err) {
    return jsonError(
      `KiCad import failed: ${err instanceof Error ? err.message : String(err)}`,
      422,
    );
  }
}

/** imported projects/components are private to the caller's org by default */
export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return jsonError("forbidden", 403);
  return Response.json({
    formats: [".kicad_mod (footprint -> library)", ".kicad_pcb + .kicad_sch (project)"],
    altium: "export from Altium, open in KiCad (native .SchDoc/.PcbDoc import), save as KiCad, upload here",
  });
}
