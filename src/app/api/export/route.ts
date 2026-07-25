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
import JSZip from "jszip";
import { getProject } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 120;

// Every exporter pins a slightly different circuit-json version (the layer
// unions differ), so each call site casts to its own expected input type.
type AnyCircuitJson = Parameters<typeof convertSoupToGerberCommands>[0];
type BomCircuitJson = Parameters<typeof convertCircuitJsonToBomRows>[0]["circuitJson"];
type PnpCircuitJson = Parameters<typeof convertCircuitJsonToPickAndPlaceCsv>[0];
type DrillCircuitJson = Parameters<typeof convertSoupToExcellonDrillCommands>[0]["circuitJson"];

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "default";
  const kind = url.searchParams.get("kind");

  let circuitJson: AnyCircuitJson;
  try {
    circuitJson = (await runTscircuitCode(await getProject(projectId), {
      mainComponentPath: "main.tsx",
    })) as AnyCircuitJson;
  } catch (err) {
    return Response.json(
      { error: `Compile failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 422 },
    );
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
      default:
        return Response.json({ error: "kind must be gerber | bom | pnp" }, { status: 400 });
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
