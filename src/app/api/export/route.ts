import { runTscircuitCode } from "@tscircuit/eval";
import {
  convertSoupToExcellonDrillCommands,
  convertSoupToGerberCommands,
  stringifyExcellonDrill,
  stringifyGerberCommandLayers,
} from "circuit-json-to-gerber";
import { convertCircuitJsonToPickAndPlaceRows } from "circuit-json-to-pnp-csv";
import { convertCircuitJsonToSchematicSvg } from "circuit-to-svg";
import JSZip from "jszip";
import { bomToCsv, buildBom, centriDiMontaggio, pnpToCsv } from "@/lib/bom";
import { senzaRotazioneDiCarico } from "@/lib/gerber-rotation";
import { serigrafiaStampabile } from "@/lib/silk-stroke";
import { viePassantiSuOgniStrato } from "@/lib/via-layers";
import { withLibrary } from "@/lib/agent-tools";
import { requireProjectAccess } from "@/lib/acl";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { applyManualEditsToFsMap } from "@/lib/manual-edits";
import {
  filesHash,
  getCompileCache,
  getProject,
  hasBoard,
  isValidProjectId,
} from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 120;

// Every exporter pins a slightly different circuit-json version (the layer
// unions differ), so each call site casts to its own expected input type.
type AnyCircuitJson = Parameters<typeof convertSoupToGerberCommands>[0];
type PnpCircuitJson = Parameters<typeof convertCircuitJsonToPickAndPlaceRows>[0];
type DrillCircuitJson = Parameters<typeof convertSoupToExcellonDrillCommands>[0]["circuitJson"];
type SchematicCircuitJson = Parameters<typeof convertCircuitJsonToSchematicSvg>[0];

const KINDS = new Set(["gerber", "bom", "bom-json", "pnp", "schematic"]);

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "default";
  const kind = url.searchParams.get("kind");
  // the id ends up in a Content-Disposition header: only ids the app can make
  if (!isValidProjectId(projectId)) {
    return Response.json({ error: "projectId non valido" }, { status: 400 });
  }
  if (!kind || !KINDS.has(kind)) {
    return Response.json(
      { error: "kind must be gerber | bom | bom-json | pnp | schematic" },
      { status: 400 },
    );
  }

  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const fsMap = await withLibrary(await getProject(projectId));

  // Gerber/BOM/PnP must come from the SAME routed circuit the agent validated:
  // the compile cache, produced by the full compile (manual edits, our router,
  // house rules, project design rules, pours, hand-drawn routes) and checked.
  /*
   * The BOM looks at the COMPONENTS, not the traces: if a saved compilation
   * exists it is used even when the files changed afterwards. Previously every
   * BOM view triggered a full compile with routing — minutes of waiting for a
   * table that was already there.
   */
  const wantsComponentsOnly = kind === "bom" || kind === "bom-json";
  const fabrication = kind === "gerber" || kind === "pnp";

  let circuitJson: AnyCircuitJson;
  const cache = await getCompileCache(projectId).catch(() => null);
  const cacheFresh =
    !!cache &&
    cache.filesHash === filesHash(fsMap) &&
    cache.engineVersion >= CHECKS_ENGINE_VERSION &&
    hasBoard(cache.circuitJson);
  if (fabrication && !cacheFresh) {
    /*
     * NO FALLBACK FOR WHAT GOES TO THE FACTORY. It used to recompile here with
     * the bare tscircuit pipeline: a board without the user's manual edits,
     * without our router, the house rules, the project's design rules, the
     * re-poured planes and the hand-drawn traces — a different board from the
     * one on screen, never checked, shipped as Gerber. A board that cannot be
     * exported as it was verified is not exported: it is recompiled first.
     */
    const motivo = !cache
      ? "non c'e' una scheda compilata"
      : !hasBoard(cache.circuitJson)
        ? "l'ultima compilazione non ha prodotto una scheda"
        : cache.filesHash !== filesHash(fsMap)
          ? "i file sono cambiati dopo l'ultima compilazione"
          : "la scheda e' stata verificata con controlli piu' vecchi";
    return Response.json(
      {
        error: `ricompila la scheda prima di esportare: ${motivo}`,
        reason: motivo,
      },
      { status: 409 },
    );
  }
  const componentsInCache =
    !!cache &&
    (cache.circuitJson as Array<{ type?: unknown }>).some((el) => el?.type === "source_component");
  if (cache && (cacheFresh || (wantsComponentsOnly && componentsInCache))) {
    circuitJson = cache.circuitJson as AnyCircuitJson;
  } else {
    // BOM and schematic only: they depend on the parts, not on the copper. The
    // manual edits still apply, so the schematic is the one the user arranged
    try {
      circuitJson = (await runTscircuitCode(applyManualEditsToFsMap(fsMap), {
        mainComponentPath: "main.tsx",
      })) as AnyCircuitJson;
    } catch (err) {
      return Response.json(
        { error: `Compile failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 422 },
      );
    }
  }

  try {
    switch (kind) {
      case "bom": {
        return csvResponse(bomToCsv(buildBom(circuitJson as never, fsMap)), "bom.csv");
      }
      // same rows as the downloadable BOM, in JSON: the on-screen table
      // must not be able to diverge from the file that goes to production
      case "bom-json": {
        return Response.json({ rows: buildBom(circuitJson as never, fsMap) });
      }
      case "pnp": {
        // the library's rows, our CSV: no formulas, rotations in [0, 360)
        // the body centre, not the middle of the footprint box (see centriDiMontaggio)
        const csv = pnpToCsv(
          centriDiMontaggio(
            convertCircuitJsonToPickAndPlaceRows(circuitJson as unknown as PnpCircuitJson),
            circuitJson as unknown[],
          ),
        );
        return csvResponse(csv, "pnp.csv");
      }
      case "gerber": {
        const zip = new JSZip();
        // a silkscreen pen thinner than a fab can print is widened (see silk-stroke)
        // a pad at an angle is written as a region, not as a rotated aperture (see gerber-rotation)
        const ruotate = senzaRotazioneDiCarico(
          // through vias get their pad on the inner layers too (see via-layers)
          stringifyGerberCommandLayers(convertSoupToGerberCommands(viePassantiSuOgniStrato(circuitJson as never) as AnyCircuitJson)),
        );
        if (ruotate.nonConvertiti.length > 0) {
          console.warn(`[export] ${projectId}: rotated apertures left as %LR on ${ruotate.nonConvertiti.join(", ")}`);
        }
        const { layers: gerberLayers } = serigrafiaStampabile(ruotate.layers);
        for (const [layerName, content] of Object.entries(gerberLayers)) {
          zip.file(`${layerName}.gbr`, content as string);
        }
        for (const isPlated of [true, false]) {
          const drill = convertSoupToExcellonDrillCommands({
            circuitJson: circuitJson as unknown as DrillCircuitJson,
            is_plated: isPlated,
          });
          zip.file(
            isPlated ? "drill_plated.drl" : "drill_unplated.drl",
            stringifyExcellonDrill(drill),
          );
        }
        const buffer = await zip.generateAsync({ type: "nodebuffer" });
        return new Response(new Uint8Array(buffer), {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${projectId}-gerber.zip"`,
          },
        });
      }
      case "schematic": {
        // same drawing the user sees in the viewer and the agent validated:
        // it comes from the same compile cache as the other exports
        const svg = convertCircuitJsonToSchematicSvg(
          circuitJson as unknown as SchematicCircuitJson,
        );
        return new Response(svg, {
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "content-disposition": `attachment; filename="${projectId}-schematic.svg"`,
          },
        });
      }
      default:
        return Response.json(
          { error: "kind must be gerber | bom | pnp | schematic" },
          { status: 400 },
        );
    }
  } catch (err) {
    return Response.json(
      { error: `Export failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
