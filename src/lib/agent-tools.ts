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

    case "compile":
      return { result: await compileProject(fsMap) };

    default:
      return { result: { error: `Unknown tool: ${name}` } };
  }
}
