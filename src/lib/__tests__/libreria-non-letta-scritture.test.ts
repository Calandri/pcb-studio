import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * THE LIBRARY THAT CANNOT BE READ MUST NOT COST A WRITE. A compile without the
 * library does not start and says so (libreria-non-letta.test.ts); but the
 * hand positions saved from the page, the release of a part over MCP and the
 * board just compiled do not need the library to be saved, and used to fail
 * with it: a 409 on every drag, an exception out of release_manual_edits, a
 * compiled board thrown away at its end (review of 12/11/2026).
 */
const lib = vi.hoisted(() => ({ fallimenti: 0, chiamate: 0, file: { "lib/Sensore.tsx": "export const Sensore = () => null" } as Record<string, string> }));
vi.mock("@/lib/library-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/library-store")>();
  return {
    ...vero,
    getLibraryFsMap: vi.fn(async () => {
      lib.chiamate++;
      if (lib.fallimenti > 0) {
        lib.fallimenti--;
        throw Object.assign(new Error("Error connecting to database: fetch failed"), { sourceError: Object.assign(new Error("connect ETIMEDOUT 10.0.0.12:5432"), { code: "ETIMEDOUT" }) });
      }
      return lib.file;
    }),
  };
});

const db = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  meta: null as null | { filesHash: string; createdAt: unknown; engineVersion: number },
  saves: [] as Array<{ hash: string; opts: unknown }>,
}));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    getProject: vi.fn(async () => ({ ...db.files })),
    updateProjectFile: vi.fn(async (_p: string, path: string, change: (c: string | null) => string | null) => {
      const next = change(db.files[path] ?? null);
      if (next === null) return { written: false, content: db.files[path] ?? null };
      db.files[path] = next;
      return { written: true, content: next };
    }),
    getCompileMeta: vi.fn(async () => db.meta),
    getCompileCache: vi.fn(async () => null),
    saveCompileCache: vi.fn(async (_p: string, hash: string, _cj: unknown, _s: unknown, _e: number, opts: unknown) => {
      db.saves.push({ hash, opts });
      return { saved: true };
    }),
  };
});

import { LibreriaNonLetta, withLibrary } from "@/lib/agent-tools";
import { saveFinishedCompile } from "@/lib/compile-save";
import type { CompileSummary } from "@/lib/compile";
import { MANUAL_EDITS_PATH, parseManualEdits } from "@/lib/manual-edits";
import { commitManualEdits } from "@/lib/manual-edits-store";
import { filesHash } from "@/lib/project-store";

const MAIN = 'export default () => <board width="10mm" height="10mm" />';

describe("the library read again once, and never at the cost of a write", () => {
  beforeEach(() => {
    lib.fallimenti = 0;
    lib.chiamate = 0;
    db.files = { "main.tsx": MAIN };
    db.meta = null;
    db.saves = [];
  });

  it("a passing error of the database: the second read mounts the library", async () => {
    lib.fallimenti = 1;
    expect(await withLibrary({ "main.tsx": "x" })).toEqual({ ...lib.file, "main.tsx": "x" });
    expect(lib.chiamate).toBe(2);
  });

  it("two failed reads: the library is not read, said once, after two tries", async () => {
    lib.fallimenti = 2;
    await expect(withLibrary({ "main.tsx": "x" })).rejects.toBeInstanceOf(LibreriaNonLetta);
    expect(lib.chiamate).toBe(2);
  });

  it("hand positions are saved without the library, with no base and a warning that says so", async () => {
    const cache = { filesHash: filesHash({ ...lib.file, "main.tsx": MAIN }) };
    // with the library: the base of the board is written as always
    const conLibreria = await commitManualEdits("p", cache, (e) => ({ ...e, pcb_placements: [{ selector: "R1", center: { x: 1, y: 2 } }] }));
    expect(conLibreria.written).toBe(true);
    expect(conLibreria.avviso).toBeUndefined();
    expect(parseManualEdits(db.files[MANUAL_EDITS_PATH]).board_base?.files_hash).toBe(cache.filesHash);
    // without: saved all the same, the base not written, and said
    lib.fallimenti = 2;
    const senza = await commitManualEdits("p", cache, (e) => ({ ...e, pcb_placements: [{ selector: "R1", center: { x: 3, y: 4 } }] }));
    expect(senza.written).toBe(true);
    expect(senza.edits.pcb_placements).toEqual([{ selector: "R1", center: { x: 3, y: 4 } }]);
    expect(parseManualEdits(db.files[MANUAL_EDITS_PATH]).pcb_placements).toEqual([{ selector: "R1", center: { x: 3, y: 4 } }]);
    expect(parseManualEdits(db.files[MANUAL_EDITS_PATH]).board_base).toBeUndefined();
    expect(senza.avviso).toMatch(/^libreria dei componenti non letta: .*Posizioni salvate lo stesso/);
  });

  it("a compile whose files cannot be read again at its end is saved, on the condition that the saved row has not changed", async () => {
    const summary = { message: "ok" } as unknown as CompileSummary;
    const startedAt = Date.parse("2026-11-12T10:00:00Z");
    const nonLetti = async () => {
      throw new LibreriaNonLetta(new Error("fetch failed"));
    };
    // an older board of other files: ours goes over it, only if it is still that one
    db.meta = { filesHash: "vecchia", createdAt: "2026-11-12T09:00:00Z", engineVersion: 11 };
    const r = await saveFinishedCompile("p", "nostra", [{ type: "pcb_board" }], summary, { startedAt, filesNow: nonLetti });
    expect(r.saved).toBe(true);
    expect(db.saves).toEqual([{ hash: "nostra", opts: { ifUnchangedSince: { filesHash: "vecchia", createdAt: "2026-11-12T09:00:00Z" } } }]);
    // a board of other files saved after this compile started: not overwritten
    db.saves = [];
    db.meta = { filesHash: "altra", createdAt: "2026-11-12T10:05:00Z", engineVersion: 11 };
    const dopo = await saveFinishedCompile("p", "nostra", [{ type: "pcb_board" }], summary, { startedAt, filesNow: nonLetti });
    expect(dopo).toMatchObject({ saved: false, superseded: true });
    expect(db.saves).toEqual([]);
    // nothing saved yet: saved
    db.meta = null;
    expect((await saveFinishedCompile("p", "nostra", [{ type: "pcb_board" }], summary, { startedAt, filesNow: nonLetti })).saved).toBe(true);
  });
});
