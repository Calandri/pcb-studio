import { currentViewer } from "@/lib/acl";
import { deleteLlmKey, listMaskedKeys, LLM_PROVIDERS, saveLlmKey, type LlmProvider } from "@/lib/llm-keys";
import { getUserRoleInOrg, listUserOrganizations } from "@/lib/org-store";

export const runtime = "nodejs";

/**
 * Copilot API keys (BYOK). Scope "user": only the user uses them. Scope
 * "org": the whole organization shares them — set by owners and admins.
 */

export async function GET(): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthorized" }, { status: 401 });
  const orgs = await listUserOrganizations(viewer.userId).catch(() => []);
  const keys = await listMaskedKeys(
    viewer.userId,
    orgs.map((o) => o.id),
  );
  return Response.json({
    keys,
    orgs: orgs.map((o) => ({ id: o.id, name: o.name, role: o.role })),
  });
}

export async function POST(req: Request): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const provider = String(body?.provider ?? "") as LlmProvider;
  const scope = body?.scope === "org" ? "org" : "user";
  const key = String(body?.key ?? "").trim();
  const orgId = String(body?.orgId ?? "");

  if (!LLM_PROVIDERS.includes(provider)) {
    return Response.json({ error: `provider non valido: ${provider}` }, { status: 400 });
  }
  if (key.length < 16 || key.length > 200 || /\s/.test(key)) {
    return Response.json({ error: "chiave non valida" }, { status: 400 });
  }

  let ownerId = viewer.userId;
  if (scope === "org") {
    const role = await getUserRoleInOrg(viewer.userId, orgId);
    if (role !== "owner" && role !== "admin") {
      return Response.json(
        { error: "solo owner e admin possono impostare le chiavi dell'organizzazione" },
        { status: 403 },
      );
    }
    ownerId = orgId;
  }

  await saveLlmKey(scope, ownerId, provider, key, viewer.email);
  return Response.json({ ok: true });
}

export async function DELETE(req: Request): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const provider = String(url.searchParams.get("provider") ?? "") as LlmProvider;
  const scope = url.searchParams.get("scope") === "org" ? "org" : "user";
  const orgId = String(url.searchParams.get("orgId") ?? "");

  if (!LLM_PROVIDERS.includes(provider)) {
    return Response.json({ error: `provider non valido: ${provider}` }, { status: 400 });
  }

  let ownerId = viewer.userId;
  if (scope === "org") {
    const role = await getUserRoleInOrg(viewer.userId, orgId);
    if (role !== "owner" && role !== "admin") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    ownerId = orgId;
  }

  await deleteLlmKey(scope, ownerId, provider);
  return Response.json({ ok: true });
}
