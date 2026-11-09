/*
 * Which copy of the patched tscircuit libraries the compiler REALLY loads.
 *
 * patches/ fixes two libraries that @tscircuit/core imports: the section
 * frames (calculate-cell-boundaries) and the net-label solver
 * (@tscircuit/schematic-trace-solver). The second one core imports without
 * declaring it (only a devDependency of @tscircuit/core 0.0.1512): left alone,
 * it was found only through pnpm's hidden hoisting, and nothing said which
 * copy a build had picked. On Vercel a compile of fototrappola-frontale with
 * the patches took as long as one without, and there was no way to tell.
 *
 * Here the packages are looked up the way Node does it from core's own
 * folder (node_modules up the tree, from core's real path), and their entry
 * file is checked for a string only the patched build contains. The same
 * check runs before and after `next build` (scripts/check-patches.mjs: a
 * build with an unpatched copy fails) and at every compile, whose summary
 * carries the result read on the machine that compiled.
 *
 * Plain .mjs so the build script can run it with node, without a compiler.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

/** the libraries patched in patches/, with a string only their patched build contains */
export const PATCHED_LIBRARIES = [
  { name: "calculate-cell-boundaries", marker: "PCB_STUDIO_EXACT_MAX_CELLS" },
  { name: "@tscircuit/schematic-trace-solver", marker: "pcbStudioSegmentGrids" },
];

/** a package as Node finds it from a folder: node_modules/<name>, walking up */
function packageDirFrom(startDir, name) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return path.dirname(realpathSync(candidate));
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** the file `import "<name>"` loads: the "." export, else main, else dist/index.js */
function entryFile(pkgDir) {
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  } catch {
    // unreadable package.json: the default entry below
  }
  const dot = pkg.exports && typeof pkg.exports === "object" ? pkg.exports["."] ?? pkg.exports : pkg.exports;
  const fromExports =
    typeof dot === "string" ? dot : dot && typeof dot === "object" ? dot.import ?? dot.default : undefined;
  const entry = typeof fromExports === "string" ? fromExports : pkg.module ?? pkg.main ?? "dist/index.js";
  return path.join(pkgDir, entry);
}

/**
 * Every @tscircuit/core the app can load: the one in node_modules and the
 * ones next build links for its external packages (.next/node_modules/@tscircuit/core-<hash>).
 */
function coreDirs(root) {
  const found = new Set();
  const add = (p) => {
    try {
      if (existsSync(path.join(p, "package.json"))) found.add(realpathSync(p));
    } catch {
      // a dangling link is not a core
    }
  };
  add(path.join(root, "node_modules", "@tscircuit", "core"));
  const built = path.join(root, ".next", "node_modules", "@tscircuit");
  try {
    for (const name of readdirSync(built)) if (/^core(-[0-9a-f]+)?$/.test(name)) add(path.join(built, name));
  } catch {
    // no build yet
  }
  return [...found];
}

/**
 * @param {string} [root] the app folder (process.cwd() in the app and in the build)
 * @returns {{ ok: boolean, libraries: Array<{ name: string, patched: boolean, file: string | null }> }}
 */
export function patchedLibraries(root = process.cwd()) {
  const cores = coreDirs(root);
  const libraries = [];
  for (const core of cores) {
    for (const lib of PATCHED_LIBRARIES) {
      const dir = packageDirFrom(path.join(core, "dist"), lib.name);
      const file = dir ? entryFile(dir) : null;
      let patched = false;
      try {
        patched = Boolean(file && readFileSync(file, "utf8").includes(lib.marker));
      } catch {
        patched = false;
      }
      libraries.push({ name: lib.name, patched, file: file ? path.relative(root, file) : null });
    }
  }
  if (cores.length === 0) {
    for (const lib of PATCHED_LIBRARIES) libraries.push({ name: lib.name, patched: false, file: null });
  }
  return { ok: libraries.length > 0 && libraries.every((l) => l.patched), libraries };
}
