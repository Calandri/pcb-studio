import { describe, expect, it } from "vitest";
import { compileProject } from "@/lib/compile";
import { applyManualEditsToFsMap } from "@/lib/manual-edits";
import { filesHash } from "@/lib/project-store";

const MAIN = `export default () => (
  <board width="10mm" height="10mm">
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={0} pcbY={0} />
  </board>
)
`;

describe("compile leaves the project files alone", () => {
  it("applyManualEditsToFsMap returns a copy even without manual edits", () => {
    const files = { "main.tsx": MAIN };
    expect(applyManualEditsToFsMap(files)).not.toBe(files);
  });

  it("the hash of the files is the same before and after compileProject", async () => {
    const files = { "main.tsx": MAIN };
    const before = filesHash(files);
    await compileProject(files, { route: false });
    expect(Object.keys(files)).toEqual(["main.tsx"]);
    expect(filesHash(files)).toBe(before);
  }, 120_000);
});
