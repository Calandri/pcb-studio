import { runTscircuitCode } from "@tscircuit/eval";
import { convertCircuitJsonToGltf } from "circuit-json-to-gltf";
import { withLibrary } from "@/lib/agent-tools";
import { requireProjectAccess } from "@/lib/acl";
import { filesHash, getCompileCache, getProject } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * La scheda come GLB per il designer 3D. Come per la distinta, il 3D guarda i
 * componenti e non il rame instradato: se esiste una compilazione salvata la si
 * usa anche quando i sorgenti sono cambiati dopo (la geometria dei componenti
 * non dipende dallo sbroglio). La conversione e' pesante, quindi il GLB resta
 * in memoria per filesHash: stesso progetto + stessi file = stesso modello.
 */
type GltfCircuitJson = Parameters<typeof convertCircuitJsonToGltf>[0];

const glbCache = new Map<string, ArrayBuffer>();

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const fsMap = await withLibrary(await getProject(projectId));
  const hash = filesHash(fsMap);
  const cacheKey = `${projectId}:${hash}`;

  const cached = glbCache.get(cacheKey);
  if (cached) return glbResponse(cached);

  let circuitJson: GltfCircuitJson;
  const compile = await getCompileCache(projectId).catch(() => null);
  if (compile?.circuitJson?.length) {
    circuitJson = compile.circuitJson as GltfCircuitJson;
  } else {
    try {
      circuitJson = (await runTscircuitCode(fsMap, {
        mainComponentPath: "main.tsx",
      })) as GltfCircuitJson;
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 422 },
      );
    }
  }

  try {
    const gltf = await convertCircuitJsonToGltf(circuitJson, {
      format: "glb",
      boardDrillQuality: "fast",
    });
    const bytes = toArrayBuffer(gltf);
    // tiene al massimo gli ultimi modelli: il lambda e' caldo per poco tempo
    if (glbCache.size >= 8) glbCache.delete(glbCache.keys().next().value!);
    glbCache.set(cacheKey, bytes);
    return glbResponse(bytes);
  } catch (err) {
    return Response.json(
      { error: `conversione GLB fallita: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

function toArrayBuffer(gltf: unknown): ArrayBuffer {
  if (gltf instanceof ArrayBuffer) return gltf;
  if (gltf instanceof Uint8Array) {
    return gltf.buffer.slice(gltf.byteOffset, gltf.byteOffset + gltf.byteLength) as ArrayBuffer;
  }
  // alcuni percorsi restituiscono l'oggetto glTF JSON invece del binario
  return new TextEncoder().encode(JSON.stringify(gltf)).buffer as ArrayBuffer;
}

function glbResponse(bytes: ArrayBuffer): Response {
  return new Response(bytes, {
    headers: {
      "content-type": "model/gltf-binary",
      "cache-control": "private, max-age=300",
    },
  });
}
