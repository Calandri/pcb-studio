import { parseVerifyParams, renderVerifyPage, VERIFY_PAGE_HEADERS } from "@/lib/magic-link";

/*
 * Magic-link interstitial (see src/lib/magic-link.ts). A GET here never
 * touches the token: mail scanners can open it as often as they like. The
 * token is not logged.
 */
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const url = new URL(request.url);
  const params = parseVerifyParams(url.searchParams, url.origin);
  return new Response(renderVerifyPage(params), {
    status: params ? 200 : 400,
    headers: VERIFY_PAGE_HEADERS,
  });
}
