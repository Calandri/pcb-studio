import { z } from "zod";
import { currentViewer } from "@/lib/acl";
import { createApiToken, listApiTokens, revokeApiToken } from "@/lib/api-tokens";

export const runtime = "nodejs";

const BodySchema = z.union([
  z.object({ action: z.literal("create"), name: z.string().max(60).optional() }),
  z.object({ action: z.literal("revoke"), id: z.string().uuid() }),
]);

export async function GET(): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthenticated" }, { status: 401 });
  return Response.json({ tokens: await listApiTokens(viewer.userId) });
}

export async function POST(req: Request): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid body" }, { status: 400 });

  if (parsed.data.action === "revoke") {
    await revokeApiToken(viewer.userId, parsed.data.id);
    return Response.json({ ok: true, tokens: await listApiTokens(viewer.userId) });
  }

  // the plaintext token travels only ONCE, here: afterwards only the hash remains
  const { token, info } = await createApiToken(
    viewer.userId,
    parsed.data.name ?? "Claude Code",
  );
  return Response.json({
    token,
    info,
    tokens: await listApiTokens(viewer.userId),
  });
}
