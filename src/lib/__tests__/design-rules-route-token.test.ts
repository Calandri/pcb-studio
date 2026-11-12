import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The design rules route opens to the two doors of acl.accessoDaRichiesta:
 * the browser session and the personal token (pcbs_...) of scripts and MCP.
 * The real acl and api-tokens run here against a fake database, so the check
 * is the real one: owner token gets in, no token or an unknown token does not,
 * and a token that can only view cannot write.
 */

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

const stato = vi.hoisted(() => ({
  sessione: null as null | { user: { id: string; email: string } },
  token: new Map<string, { id: string; user_id: string; email: string }>(),
  progetto: { id: "htl-prova", org_id: null, created_by: "u-owner", visibility: "private" },
  condivisioni: new Map<string, string>(),
  scritti: [] as Array<{ id: string; path: string; content: string }>,
}));

vi.mock("@neondatabase/serverless", () => ({
  neon: () =>
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join("?");
      if (q.includes("UPDATE api_tokens")) return [];
      if (q.includes("FROM api_tokens")) {
        const riga = stato.token.get(String(values[0]));
        return riga ? [riga] : [];
      }
      if (q.includes("FROM projects WHERE id")) {
        return values[0] === stato.progetto.id ? [stato.progetto] : [];
      }
      if (q.includes("FROM organization_members")) return [];
      if (q.includes("FROM project_shares")) {
        const role = stato.condivisioni.get(`${values[0]}|${values[1]}`);
        return role ? [{ role }] : [];
      }
      throw new Error(`query inattesa: ${q}`);
    },
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => stato.sessione) }));
vi.mock("@/lib/org-store", () => ({
  getUserRoleInOrg: vi.fn(async () => null),
  listUserOrganizations: vi.fn(async () => []),
}));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    getProject: vi.fn(async () => ({})),
    createProject: vi.fn(async () => {}),
    writeProjectFile: vi.fn(async (id: string, path: string, content: string) => {
      stato.scritti.push({ id, path, content });
    }),
    // the route writes over the file as it is at write time (it keeps the stackup): here the project has no file yet
    updateProjectFile: vi.fn(async (id: string, path: string, change: (current: string | null) => string | null) => {
      const content = change(null);
      if (content !== null) stato.scritti.push({ id, path, content });
      return { written: content !== null, content };
    }),
  };
});

import { GET, POST } from "@/app/api/design-rules/route";

const TOKEN_OWNER = "pcbs_prova-proprietario";
const TOKEN_VIEWER = "pcbs_prova-lettore";
const TOKEN_ESTRANEO = "pcbs_prova-estraneo";

const BASE = "https://pcb.example.com/api/design-rules";

const conToken = (token?: string): Record<string, string> =>
  token ? { authorization: `Bearer ${token}` } : {};

const post = (token?: string) =>
  POST(
    new Request(BASE, {
      method: "POST",
      headers: { "content-type": "application/json", ...conToken(token) },
      body: JSON.stringify({ projectId: "htl-prova", preset: "jlcpcb_enhanced" }),
    }),
  );

const get = (token?: string) =>
  GET(new Request(`${BASE}?projectId=htl-prova`, { headers: conToken(token) }));

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgres://prova");
  vi.stubEnv("AUTH_ALLOWED_DOMAINS", "example.com");
  vi.stubEnv("AUTH_ALLOWED_EMAILS", "");
  stato.sessione = null;
  stato.scritti.length = 0;
  stato.token.clear();
  stato.token.set(sha(TOKEN_OWNER), { id: "t1", user_id: "u-owner", email: "owner@example.com" });
  stato.token.set(sha(TOKEN_VIEWER), { id: "t2", user_id: "u-viewer", email: "viewer@example.com" });
  stato.token.set(sha(TOKEN_ESTRANEO), { id: "t3", user_id: "u-other", email: "other@example.com" });
  stato.condivisioni.clear();
  stato.condivisioni.set("htl-prova|u-viewer", "viewer");
});

describe("design rules route: bearer token", () => {
  it("lets the owner's token write the rules", async () => {
    const res = await post(TOKEN_OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; current: { preset: string } };
    expect(body.ok).toBe(true);
    expect(body.current.preset).toBe("jlcpcb_enhanced");
    expect(stato.scritti).toHaveLength(1);
    expect(stato.scritti[0].path).toBe("design-rules.json");
  });

  it("lets the owner's token read the rules", async () => {
    const res = await get(TOKEN_OWNER);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("refuses a request with no token and no session", async () => {
    expect((await post()).status).toBe(403);
    expect((await get()).status).toBe(403);
    expect(stato.scritti).toHaveLength(0);
  });

  it("refuses an unknown token", async () => {
    const res = await post("pcbs_non-esiste");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect((await get("pcbs_non-esiste")).status).toBe(403);
    expect(stato.scritti).toHaveLength(0);
  });

  it("refuses the token of a user with no access to the project", async () => {
    expect((await post(TOKEN_ESTRANEO)).status).toBe(403);
    expect((await get(TOKEN_ESTRANEO)).status).toBe(403);
    expect(stato.scritti).toHaveLength(0);
  });

  it("a view-only token reads but does not write", async () => {
    expect((await get(TOKEN_VIEWER)).status).toBe(200);
    expect((await post(TOKEN_VIEWER)).status).toBe(403);
    expect(stato.scritti).toHaveLength(0);
  });

  it("an unknown token does not fall back to the session", async () => {
    stato.sessione = { user: { id: "u-owner", email: "owner@example.com" } };
    expect((await post("pcbs_non-esiste")).status).toBe(403);
    expect(stato.scritti).toHaveLength(0);
  });

  it("the browser session still works", async () => {
    stato.sessione = { user: { id: "u-owner", email: "owner@example.com" } };
    expect((await post()).status).toBe(200);
    expect((await get()).status).toBe(200);
  });
});
