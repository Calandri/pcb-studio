import { runTscircuitCode } from "@tscircuit/eval";
import {
  convertCircuitJsonToPcbSvg,
  convertCircuitJsonToSchematicSvg,
} from "circuit-to-svg";
import { currentViewer } from "@/lib/acl";
import { getLibraryComponent } from "@/lib/library-store";

export const runtime = "nodejs";
export const maxDuration = 60;

const cache = new Map<string, { svg: string; at: number }>();
const CACHE_TTL_MS = 60_000;

/**
 * Render of the library component: compiles its TSX code and returns
 * the SVG of the schematic or the PCB footprint. Short in-memory cache.
 */
export async function GET(req: Request): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? "";
  const view = url.searchParams.get("view") ?? "schematic";
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
    return Response.json({ error: "invalid name" }, { status: 400 });
  }
  if (view !== "schematic" && view !== "pcb") {
    return Response.json({ error: "view must be schematic | pcb" }, { status: 400 });
  }

  const cacheKey = `${name}:${view}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return svgResponse(hit.svg);

  const component = await getLibraryComponent(name);
  if (!component) return Response.json({ error: "not found" }, { status: 404 });

  try {
    const fsMap: Record<string, string> = {
      "main.tsx": `import { ${name} } from "./lib/${name}"\nexport default () => (\n  <board width="30mm" height="20mm">\n    <${name} name="U1" />\n  </board>\n)\n`,
      [`lib/${name}.tsx`]: component.code,
    };
    const circuitJson = await runTscircuitCode(fsMap, { mainComponentPath: "main.tsx" });
    const errors = (circuitJson as Array<{ type: string; message?: unknown }>).filter((el) =>
      el.type.endsWith("_error"),
    );
    if (errors.length > 0) {
      return Response.json(
        { error: `component does not compile: ${String(errors[0].message ?? errors[0].type).slice(0, 200)}` },
        { status: 422 },
      );
    }
    const svg =
      view === "schematic"
        ? convertCircuitJsonToSchematicSvg(circuitJson as never)
        : convertCircuitJsonToPcbSvg(circuitJson as never);
    cache.set(cacheKey, { svg, at: Date.now() });
    return svgResponse(svg);
  } catch (err) {
    return Response.json(
      { error: `render failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

function svgResponse(svg: string): Response {
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "private, max-age=30",
    },
  });
}
