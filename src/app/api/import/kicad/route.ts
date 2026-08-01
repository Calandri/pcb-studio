import { importKicadFootprint, importKicadProject } from "@/lib/kicad-import";
import { claimProject, currentViewer, requireProjectAccess } from "@/lib/acl";
import { listUserOrganizations } from "@/lib/org-store";
import { saveLibraryComponent } from "@/lib/library-store";
import { getProject, writeProjectFile } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_FILE_BYTES = 5 * 1024 * 1024;

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/**
 * KiCad import (Fase 3.g). Multipart with one or more files:
 * - a .kicad_mod file -> footprint becomes a shared library component
 * - a .kicad_pcb (optionally with its .kicad_sch) -> becomes a NEW project
 *   (kicad-<name>-<suffix>) owned by the caller, never overwrites existing work
 *
 * Altium: no open converter — export from Altium, open in KiCad (it imports
 * .SchDoc/.PcbDoc natively), save as KiCad and upload here.
 */
export async function POST(req: Request): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return jsonError("unauthenticated", 401);

  const form = await req.formData().catch(() => null);
  if (!form) return jsonError("multipart form data required", 400);

  const files: Array<{ path: string; content: string }> = [];
  for (const entry of form.getAll("file")) {
    if (!(entry instanceof File)) continue;
    if (entry.size > MAX_FILE_BYTES) {
      return jsonError(`file "${entry.name}" too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB)`, 413);
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
    let project: { id: string; components: number; traces: number } | null = null;
    if (pcbs.length === 1) {
      const imported = importKicadProject([...pcbs, ...schs]);
      const base = pcbs[0].path
        .replace(/\.kicad_pcb$/i, "")
        .replace(/[^A-Za-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .toLowerCase();
      const projectId = `kicad-${base || "board"}-${Math.random().toString(36).slice(2, 7)}`;
      await getProject(projectId); // creates the project row
      for (const [path, content] of Object.entries(imported.fsMap)) {
        await writeProjectFile(projectId, path, content);
      }
      const orgs = await listUserOrganizations(viewer.userId);
      await claimProject(projectId, viewer, orgs[0]?.id ?? null);
      project = { id: projectId, components: imported.components, traces: imported.traces };
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
