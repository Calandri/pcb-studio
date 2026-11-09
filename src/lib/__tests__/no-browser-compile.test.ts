import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The "Sbroglio" tab of fototrappola-frontale (219 parts) stayed empty with
 * tscircuit's "Tip: You can customize the autorouter using the autorouter
 * prop": with no compile saved on the server, the page compiled the board in
 * the browser with RunFrame, which on a board that big never draws, and which
 * runs tscircuit's own pipeline, autorouter included, in the person's browser.
 * The board shown is only the one the server compiled and saved; without it
 * the page says so (BoardNotCompiled). No page may mount a browser compile.
 */

const SRC = path.join(__dirname, "..", "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "__bench__") continue;
      out.push(...sources(full));
    } else if (/\.(tsx?|jsx?)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("nessuna compilazione nel browser", () => {
  const files = [...sources(path.join(SRC, "components")), ...sources(path.join(SRC, "app"))];

  it("nessuna pagina monta RunFrame o il runner di tscircuit", () => {
    const offenders = files.filter((f) =>
      /["']@tscircuit\/runframe|["']@tscircuit\/eval\/(worker|webworker|blob-url)|<RunFrame\b/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("senza scheda salvata il riquadro dice di ricompilare", () => {
    const studio = readFileSync(path.join(SRC, "components", "Studio.tsx"), "utf8");
    expect(studio).toMatch(/<BoardNotCompiled\b/);
    const panel = readFileSync(path.join(SRC, "components", "workspace", "BoardNotCompiled.tsx"), "utf8");
    expect(panel).toMatch(/Scheda non ancora compilata/);
    expect(panel).toMatch(/Ricompila/);
  });
});

describe("nessuna route compila con l'instradatore di tscircuit", () => {
  /*
   * runTscircuitCode runs tscircuit's own pipeline, autorouter included: the
   * export and the 3D model used it when no compile was saved, so asking for
   * the BOM of a board never compiled could route it on the server. They use
   * compileGeometryOnly, which never routes. The library preview renders one
   * part alone on a board, with nothing to connect.
   */
  it("solo l'anteprima di un componente di libreria usa runTscircuitCode", () => {
    const api = sources(path.join(SRC, "app", "api"));
    const users = api
      .filter((f) => /runTscircuitCode\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));
    expect(users).toEqual([path.join("app", "api", "library", "render", "route.ts")]);
  });
});
