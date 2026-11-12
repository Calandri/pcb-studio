import { describe, expect, it, vi } from "vitest";

/*
 * The agent reads whether its loop converges in deltaVsPrevious: two parts
 * that hit each other are a target like the others (targets.courtyardCollisions),
 * and in the priorities of its prompt.
 */
vi.mock("@/lib/library-store", async (originale) => ({
  ...(await originale<typeof import("@/lib/library-store")>()),
  getLibraryFsMap: vi.fn(async () => ({})),
}));
vi.mock("@/lib/project-store", async (originale) => ({
  ...(await originale<typeof import("@/lib/project-store")>()),
  getProject: vi.fn(async () => ({ "main.tsx": "export default () => <board />" })),
  getCompileCache: vi.fn(async () => ({
    filesHash: "x",
    circuitJson: [],
    summary: { targets: { errors: 0, unrouted: 0, drcViolations: 0, prcViolations: 0, schematicOverlaps: 0, courtyardCollisions: 3 } },
    createdAt: "2026-11-12T00:00:00Z",
    engineVersion: 11,
  })),
}));
vi.mock("@/lib/compile", async (originale) => ({
  ...(await originale<typeof import("@/lib/compile")>()),
  compileProject: vi.fn(async () => ({
    circuitJson: [],
    summary: { ok: false, message: "m", targets: { errors: 0, unrouted: 0, drcViolations: 0, prcViolations: 0, schematicOverlaps: 0, courtyardCollisions: 1, fabClass: null, allGreen: false } },
  })),
}));
vi.mock("@/lib/compile-save", () => ({
  earlyBoardSaver: () => async () => ({ saved: true }),
  saveFinishedCompile: vi.fn(async () => ({ saved: true })),
}));

import { executeTool } from "@/lib/agent-tools";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

describe("courtyardCollisions for the agent", () => {
  it("deltaVsPrevious carries it", async () => {
    const r = await executeTool("p", "compile", {});
    expect((r.result as { deltaVsPrevious?: Record<string, unknown> }).deltaVsPrevious?.courtyardCollisions).toEqual([3, 1]);
  });

  it("the prompt puts it in the priorities, right after the errors", () => {
    expect(SYSTEM_PROMPT).toMatch(/Priority when targets conflict[^\n]*errors > courtyardCollisions[^\n]*> unrouted/);
  });
});
