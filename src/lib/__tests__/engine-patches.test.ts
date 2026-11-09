import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PATCHED_LIBRARIES, patchedLibraries } from "@/lib/engine-patches.mjs";
import { compileProject } from "@/lib/compile";

/*
 * The patches in patches/ only count if they reach the copy @tscircuit/core
 * loads. @tscircuit/core 0.0.1512 imports @tscircuit/schematic-trace-solver
 * without declaring it: package.json declares it for core (packageExtensions),
 * and these checks fail when the copy core finds is not the patched one. The
 * same check runs before and after next build (scripts/check-patches.mjs).
 */

const ROOT = path.join(__dirname, "..", "..", "..");

describe("le patch di tscircuit arrivano alla copia che il compilatore carica", () => {
  it("in questo checkout entrambe le librerie trovate da @tscircuit/core sono quelle corrette", () => {
    const { ok, libraries } = patchedLibraries(ROOT);
    expect(libraries.map((l) => l.name).sort()).toEqual(PATCHED_LIBRARIES.map((l) => l.name).sort());
    for (const lib of libraries) expect(lib, lib.name).toMatchObject({ patched: true });
    expect(ok).toBe(true);
  });

  it("il riepilogo del compile dice quali copie ha caricato", async () => {
    const MAIN = `export default () => (<board width="10mm" height="10mm" routingDisabled><resistor name="R1" resistance="1k" footprint="0402" /></board>)`;
    const { summary } = await compileProject({ "main.tsx": MAIN });
    expect(summary.profile.patches?.map((p) => p.name).sort()).toEqual(PATCHED_LIBRARIES.map((l) => l.name).sort());
    expect(summary.profile.patches?.every((p) => p.patched)).toBe(true);
  }, 120_000);

  describe("con una copia non corretta", () => {
    let dir = "";
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("fallisce, e dice quale", () => {
      dir = mkdtempSync(path.join(tmpdir(), "pcb-patches-"));
      // a pnpm-like layout: core in the virtual store, the solver only through hoisting
      const store = path.join(dir, "node_modules", ".pnpm");
      const core = path.join(store, "core@1", "node_modules", "@tscircuit", "core");
      mkdirSync(path.join(core, "dist"), { recursive: true });
      writeFileSync(path.join(core, "package.json"), JSON.stringify({ name: "@tscircuit/core", main: "dist/index.js" }));
      writeFileSync(path.join(core, "dist", "index.js"), "");
      const pkg = (name: string, body: string) => {
        const d = path.join(store, "node_modules", name);
        mkdirSync(path.join(d, "dist"), { recursive: true });
        writeFileSync(path.join(d, "package.json"), JSON.stringify({ name, main: "dist/index.js" }));
        writeFileSync(path.join(d, "dist", "index.js"), body);
      };
      pkg("calculate-cell-boundaries", "var PCB_STUDIO_EXACT_MAX_CELLS = 8;");
      pkg("@tscircuit/schematic-trace-solver", "var traceCrossesBoundsInterior = () => false;");
      mkdirSync(path.join(dir, "node_modules", "@tscircuit"), { recursive: true });
      symlinkSync(core, path.join(dir, "node_modules", "@tscircuit", "core"));

      const { ok, libraries } = patchedLibraries(dir);
      expect(ok).toBe(false);
      expect(libraries.find((l) => l.name === "calculate-cell-boundaries")?.patched).toBe(true);
      expect(libraries.find((l) => l.name === "@tscircuit/schematic-trace-solver")?.patched).toBe(false);
    });

    it("senza @tscircuit/core non dichiara niente corretto", () => {
      dir = mkdtempSync(path.join(tmpdir(), "pcb-patches-"));
      const { ok, libraries } = patchedLibraries(dir);
      expect(ok).toBe(false);
      expect(libraries.every((l) => !l.patched && l.file === null)).toBe(true);
    });
  });
});
