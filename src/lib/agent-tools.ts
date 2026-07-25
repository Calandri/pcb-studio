import type Anthropic from "@anthropic-ai/sdk";
import { compileProject } from "./compile";
import { getProject, writeProjectFile } from "./project-store";

const FILE_PATH_RE = /^[\w-]+(\/[\w-]+)*\.tsx$/;
const MAX_FILE_CHARS = 200_000;

/**
 * Generic tool contract {name, args} -> {result}. No tool influences control
 * flow: the loop continues while the model calls tools and stops on final text
 * (LLM-first rule).
 */
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "list_files",
    description: "List the tscircuit .tsx files of the current project.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_file",
    description: "Read the full content of a project file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "e.g. main.tsx" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a project file with the FULL new content (no diffs). " +
      "The browser re-renders the circuit immediately after every write.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "e.g. main.tsx" },
        content: { type: "string", description: "complete file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "search_parts",
    description:
      "Search real, in-stock JLCPCB parts (via jlcsearch). Returns LCSC part numbers, " +
      "package, stock and unit price. Use it whenever the user wants real/orderable " +
      "components, then reference the chosen part in code with " +
      'supplierPartNumbers={{ jlcpcb: ["C<lcsc>"] }} and a matching tscircuit footprint.',
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'e.g. "NE555", "AMS1117-3.3", "100nF 0603"' },
        package: { type: "string", description: 'optional package filter, e.g. "SOIC-8", "0603"' },
        limit: { type: "number", description: "max results (default 8)" },
      },
      required: ["query"],
    },
  },
  {
    name: "compile",
    description:
      "Compile the project to Circuit JSON (includes autorouting). Returns errors, " +
      "components, nets and routed-trace counts. Always compile after editing and " +
      "fix every error before answering.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export interface ToolExecution {
  result: unknown;
  /** set when the tool mutated a project file, so the FE can re-render live */
  fileChanged?: { path: string; content: string };
}

export async function executeTool(
  projectId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecution> {
  const fsMap = getProject(projectId);

  switch (name) {
    case "list_files":
      return {
        result: {
          files: Object.entries(fsMap).map(([path, content]) => ({
            path,
            chars: content.length,
          })),
        },
      };

    case "read_file": {
      const path = String(args.path ?? "");
      if (!(path in fsMap)) return { result: { error: `File not found: ${path}` } };
      return { result: { path, content: fsMap[path] } };
    }

    case "write_file": {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      if (!FILE_PATH_RE.test(path)) {
        return { result: { error: `Invalid path "${path}": only relative .tsx paths are allowed` } };
      }
      if (content.length > MAX_FILE_CHARS) {
        return { result: { error: `File too large (${content.length} chars, max ${MAX_FILE_CHARS})` } };
      }
      writeProjectFile(projectId, path, content);
      return {
        result: { ok: true, path, chars: content.length },
        fileChanged: { path, content },
      };
    }

    case "search_parts":
      return { result: await searchParts(args) };

    case "compile":
      return { result: await compileProject(fsMap) };

    default:
      return { result: { error: `Unknown tool: ${name}` } };
  }
}

const JLCSEARCH_BASE = "https://jlcsearch.tscircuit.com";

/**
 * Proxy to jlcsearch. Results are untrusted external data: only whitelisted
 * fields pass through, strings are truncated, nothing is interpreted.
 */
async function searchParts(args: Record<string, unknown>): Promise<unknown> {
  const query = String(args.query ?? "").slice(0, 120);
  if (!query.trim()) return { error: "query is required" };
  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);

  const url = new URL(`${JLCSEARCH_BASE}/api/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  if (args.package) url.searchParams.set("package", String(args.package).slice(0, 40));

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { error: `jlcsearch HTTP ${res.status}` };
    const data = (await res.json()) as {
      components?: Array<Record<string, unknown>>;
    };
    const parts = (data.components ?? []).map((c) => ({
      lcsc: `C${c.lcsc}`,
      mfr: String(c.mfr ?? "").slice(0, 80),
      package: String(c.package ?? "").slice(0, 40),
      description: String(c.description ?? "").slice(0, 120),
      stock: Number(c.stock) || 0,
      priceUsd: typeof c.price === "number" ? Math.round(c.price * 10000) / 10000 : null,
      basicPart: Boolean(c.is_basic),
      preferred: Boolean(c.is_preferred),
    }));
    return { query, parts };
  } catch (err) {
    return { error: `jlcsearch unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
