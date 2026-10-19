import { describe, expect, it } from "vitest";
import { compileBroken, hasBoard } from "@/lib/project-store";

describe("a compile with no board is not a board", () => {
  it("recognizes the failed compile", () => {
    expect(compileBroken([], { errors: [{ type: "compile_exception" }] })).toBe(true);
    expect(compileBroken([], { errors: [] })).toBe(true);
    expect(
      compileBroken([{ type: "pcb_board" }], { errors: [{ type: "compile_exception" }] }),
    ).toBe(true);
  });

  it("lets a real board through, errors and all", () => {
    expect(
      compileBroken([{ type: "pcb_board" }, { type: "source_component" }], {
        errors: [{ type: "pcb_trace_missing_error" }],
      }),
    ).toBe(false);
    expect(hasBoard([{ type: "pcb_board" }])).toBe(true);
    expect(hasBoard(null)).toBe(false);
  });
});
