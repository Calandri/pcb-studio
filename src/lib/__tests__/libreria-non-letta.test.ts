import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * withLibrary used to swallow a failed read of the library from the database:
 * the compile went on without it and said "File lib/X.tsx not found", sending
 * whoever read it after a file that was never missing. Now every compile path
 * says the library was not read, and why, with nothing sensitive in it.
 */
const lib = vi.hoisted(() => ({ errore: null as Error | null, file: { "lib/Sensore.tsx": "export const Sensore = () => null" } as Record<string, string> }));
vi.mock("@/lib/library-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/library-store")>();
  return {
    ...vero,
    getLibraryFsMap: vi.fn(async () => {
      if (lib.errore) throw lib.errore;
      return lib.file;
    }),
  };
});
vi.mock("@/lib/acl", () => ({ requireProjectAccess: vi.fn(async () => ({ viewer: null, ok: true })) }));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    getProject: vi.fn(async () => ({ "main.tsx": 'import { Sensore } from "./lib/Sensore"\nexport default () => <board width="10mm" height="10mm"><Sensore /></board>' })),
    getCompileCache: vi.fn(async () => null),
  };
});
const compilazioni = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/compile", async (originale) => {
  const vero = await originale<typeof import("@/lib/compile")>();
  return {
    ...vero,
    compileProject: vi.fn(async (...args: Parameters<typeof vero.compileProject>) => {
      compilazioni.n++;
      return vero.compileProject(...args);
    }),
  };
});

import { executeTool, LibreriaNonLetta, motivoSenzaSegreti, withLibrary } from "@/lib/agent-tools";
import { GET as esporta } from "@/app/api/export/route";

/** the error the Neon driver gives back when the network fails, with the request's address down in its cause */
const daNeon = () => {
  const causa = Object.assign(new Error("getaddrinfo ENOTFOUND ep-cool-name-123456.eu-central-1.aws.neon.tech"), { code: "ENOTFOUND" });
  return Object.assign(new Error("Error connecting to database: fetch failed (postgres://utente:segreta@ep-cool-name-123456.eu-central-1.aws.neon.tech/neondb)"), { sourceError: causa });
};

describe("the library that cannot be read", () => {
  beforeEach(() => {
    lib.errore = null;
    compilazioni.n = 0;
  });

  it("withLibrary mounts it when it is read, the project's own files first", async () => {
    expect(await withLibrary({ "main.tsx": "x", "lib/Sensore.tsx": "mio" })).toEqual({ "lib/Sensore.tsx": "mio", "main.tsx": "x" });
    expect(await withLibrary({ "main.tsx": "x" })).toEqual({ "lib/Sensore.tsx": lib.file["lib/Sensore.tsx"], "main.tsx": "x" });
  });

  it("is said with its reason, never as a missing file, and with no address, host or password", async () => {
    lib.errore = daNeon();
    const e = await withLibrary({ "main.tsx": "x" }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(LibreriaNonLetta);
    const m = (e as Error).message;
    expect(m).toMatch(/^libreria dei componenti non letta: Error connecting to database: fetch failed/);
    expect(m).toContain("[ENOTFOUND]");
    expect(m).not.toMatch(/segreta|utente:|neon\.tech|postgres:\/\//);
    expect(motivoSenzaSegreti(new Error("password=abc123 rifiutata"))).toBe("password=<nascosto> rifiutata");
  });

  it("the agent's compile answers with the reason and does not compile without the library", async () => {
    lib.errore = daNeon();
    const r = await executeTool("p", "compile", {});
    expect(r.result).toEqual({ error: expect.stringMatching(/^libreria dei componenti non letta: /) });
    expect(JSON.stringify(r.result)).not.toMatch(/not found|segreta/);
    expect(compilazioni.n).toBe(0);
  });

  it("the export answers 503 with the reason, not 'files changed'", async () => {
    lib.errore = daNeon();
    const r = await esporta(new Request("http://x/api/export?projectId=p&kind=gerber"));
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toMatch(/^libreria dei componenti non letta: /);
  });
});
