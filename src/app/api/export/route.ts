import { runTscircuitCode } from "@tscircuit/eval";
import {
  convertSoupToExcellonDrillCommands,
  convertSoupToGerberCommands,
  stringifyExcellonDrill,
  stringifyGerberCommandLayers,
} from "circuit-json-to-gerber";
import {
  convertBomRowsToCsv,
  convertCircuitJsonToBomRows,
} from "circuit-json-to-bom-csv";
import { convertCircuitJsonToPickAndPlaceCsv } from "circuit-json-to-pnp-csv";
import { convertCircuitJsonToSchematicSvg } from "circuit-to-svg";
import JSZip from "jszip";
import { withLibrary } from "@/lib/agent-tools";
import { requireProjectAccess } from "@/lib/acl";
import { filesHash, getCompileCache, getProject } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 120;

// Every exporter pins a slightly different circuit-json version (the layer
// unions differ), so each call site casts to its own expected input type.
type AnyCircuitJson = Parameters<typeof convertSoupToGerberCommands>[0];
type BomCircuitJson = Parameters<typeof convertCircuitJsonToBomRows>[0]["circuitJson"];
type PnpCircuitJson = Parameters<typeof convertCircuitJsonToPickAndPlaceCsv>[0];
type DrillCircuitJson = Parameters<typeof convertSoupToExcellonDrillCommands>[0]["circuitJson"];
type SchematicCircuitJson = Parameters<typeof convertCircuitJsonToSchematicSvg>[0];

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "default";
  const kind = url.searchParams.get("kind");

  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const fsMap = await withLibrary(await getProject(projectId));

  // Gerber/BOM/PnP must come from the SAME routed circuit the agent validated:
  // if the compile cache matches the current sources, use it instead of
  // recompiling (autorouters are not deterministic — a fresh compile could
  // route differently from what the user saw and what was DRC-checked).
  let circuitJson: AnyCircuitJson;
  const cache = await getCompileCache(projectId).catch(() => null);
  if (cache && cache.filesHash === filesHash(fsMap)) {
    circuitJson = cache.circuitJson as AnyCircuitJson;
  } else {
    try {
      circuitJson = (await runTscircuitCode(fsMap, {
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
        const rows = await convertCircuitJsonToBomRows({
          circuitJson: circuitJson as unknown as BomCircuitJson,
        });
        return csvResponse(convertBomRowsToCsv(rows), "bom.csv");
      }
      case "pnp": {
        const csv = convertCircuitJsonToPickAndPlaceCsv(
          circuitJson as unknown as PnpCircuitJson,
        );
        return csvResponse(csv, "pnp.csv");
      }
      case "gerber": {
        const zip = new JSZip();
        const gerberLayers = stringifyGerberCommandLayers(
          convertSoupToGerberCommands(circuitJson),
        );
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
        // stesso disegno che l'utente vede nel viewer e che l'agente ha
        // validato: viene dalla stessa cache di compile degli altri export
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
