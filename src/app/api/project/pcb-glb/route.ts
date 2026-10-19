import { runTscircuitCode } from "@tscircuit/eval";
import { convertCircuitJsonToGltf } from "circuit-json-to-gltf";
import { withLibrary } from "@/lib/agent-tools";
import { requireProjectAccess } from "@/lib/acl";
import { getProjectModel } from "@/lib/model-store";
import { filesHash, getCompileCache, getProject } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * The board as GLB for the 3D designer. As with the BOM, the 3D view looks at
 * the components, not the routed copper: if a saved compilation exists it is
 * used even when the sources changed afterwards (component geometry does not
 * depend on the routing). The conversion is expensive, so the GLB stays in
 * memory keyed by filesHash: same project + same files = same model.
 */
type GltfCircuitJson = Parameters<typeof convertCircuitJsonToGltf>[0];

const glbCache = new Map<string, ArrayBuffer>();

/**
 * The component meshes, put INTO the circuit before it is converted.
 *
 * An imported board's parts point at `/api/project/model?...`, which is the right
 * address for a browser and the wrong one for the converter: it treats a leading
 * slash as a file path. And it would be a request to ourselves, needing the
 * caller's cookie to get past the access check.
 *
 * So the mesh is read straight from the database — this request has already
 * checked who is asking — and travels as a `data:` URL. No round trip, no cookie
 * to forward, and it works when there is no browser at all, as when an agent asks
 * for the board.
 */
async function conModelli(
  circuitJson: GltfCircuitJson,
  projectId: string,
): Promise<GltfCircuitJson> {
  const elementi = circuitJson as unknown as Array<Record<string, unknown>>;
  const nostri = elementi.filter(
    (el) =>
      el.type === "cad_component" &&
      typeof el.model_obj_url === "string" &&
      el.model_obj_url.includes("/api/project/model"),
  );
  if (nostri.length === 0) return circuitJson;

  const cache = new Map<string, string | null>();
  for (const el of nostri) {
    const nome = new URL(String(el.model_obj_url), "https://pcb-studio.local").searchParams.get(
      "name",
    );
    if (!nome) continue;
    if (!cache.has(nome)) {
      const modello = await getProjectModel(projectId, nome).catch(() => null);
      cache.set(nome, modello?.obj ?? null);
    }
    const obj = cache.get(nome);
    if (!obj) continue;
    el.model_obj_url = `data:text/plain;base64,${Buffer.from(obj, "utf8").toString("base64")}`;
  }
  return circuitJson;
}

/** the model fields the converter loads from a URL */
const CAMPI_MODELLO = [
  "model_stl_url",
  "model_obj_url",
  "model_glb_url",
  "model_gltf_url",
  "model_step_url",
  "model_wrl_url",
];
/** public CDNs that serve the library's own 3D models (EasyEDA imports point there) */
const HOST_MODELLI = new Set(["modelcdn.tscircuit.com"]);

/**
 * THE CONVERTER FETCHES WHATEVER URL THE CIRCUIT NAMES, from the server.
 *
 * A `cadModel={{ objUrl: "http://169.254.169.254/..." }}` in the project code —
 * which the agent and anyone with edit access write — became a request from
 * our lambda to an address of the attacker's choosing (SSRF), and an absolute
 * path became a file read (`file://`). So before converting, every model URL
 * that is not a `data:` mesh (what conModelli makes of our own meshes) or an
 * https URL on a known model CDN is dropped: the part shows as a box instead of
 * as the mesh, which is the right price.
 *
 * `data:` only for OBJ and STL, which are geometry and nothing else. A glTF
 * names its buffers by URL, and the converter fetches them: a glTF inside a
 * `data:` URL would bring the same request back through the side door.
 */
function soloModelliSicuri(circuitJson: GltfCircuitJson): GltfCircuitJson {
  for (const el of circuitJson as unknown as Array<Record<string, unknown>>) {
    if (el.type !== "cad_component") continue;
    for (const campo of CAMPI_MODELLO) {
      const v = el[campo];
      if (v === undefined || v === null) continue;
      if (typeof v === "string" && modelloAmmesso(v, campo)) continue;
      delete el[campo];
    }
  }
  return circuitJson;
}

function modelloAmmesso(url: string, campo: string): boolean {
  if (url.startsWith("data:")) return campo === "model_obj_url" || campo === "model_stl_url";
  try {
    const u = new URL(url);
    return u.protocol === "https:" && HOST_MODELLI.has(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const fsMap = await withLibrary(await getProject(projectId));
  const hash = filesHash(fsMap);
  const compile = await getCompileCache(projectId).catch(() => null);
  /*
   * The key is the files AND the board they were drawn from: the same files
   * can come with a new compile (a reroute, a recheck that moved nothing but
   * re-poured the planes), and the model in memory would be the old board.
   */
  const cacheKey = `${projectId}:${hash}:${compile?.circuitJson?.length ? String(compile.createdAt) : "live"}`;

  const cached = glbCache.get(cacheKey);
  if (cached) return glbResponse(cached);

  let circuitJson: GltfCircuitJson;
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
    // the circuit was parsed for this request only: stripping it touches nothing else
    const gltf = await convertCircuitJsonToGltf(soloModelliSicuri(await conModelli(circuitJson, projectId)), {
      format: "glb",
      boardDrillQuality: "fast",
    });
    const bytes = toArrayBuffer(gltf);
    // keeps at most the most recent models: the lambda stays warm only briefly
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
  // some paths return the glTF JSON object instead of the binary
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
