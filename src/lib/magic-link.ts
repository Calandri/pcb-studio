/**
 * Magic-link interstitial.
 *
 * Auth.js email tokens are single use: the first GET of
 * `/api/auth/callback/email?token=…` consumes them. Mail security scanners
 * (Safe Links, antivirus, link previews) open every link in an email before
 * the human does, so a link pointing straight at the callback is burned by
 * the time the user clicks it and sign-in fails with `Verification`.
 *
 * The email therefore points at a first-party page (`/auth/verify`) whose GET
 * is harmless: it renders one "Accedi" button, and only that explicit click
 * submits a form to the real callback. The callback path is fixed here, never
 * taken from the request, so the page cannot be turned into an open redirect.
 *
 * No React and no I/O in this module: it is unit-tested in isolation.
 */

export const VERIFY_PATH = "/auth/verify";
export const EMAIL_CALLBACK_PATH = "/api/auth/callback/email";

/** Auth.js uses randomString(32) = 64 hex chars; accept a sane superset. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,512}$/;
const MAX_EMAIL_LENGTH = 320;
const MAX_CALLBACK_LENGTH = 2048;

export interface MagicLinkParams {
  token: string;
  email: string;
  /** Same-origin destination after sign-in; omitted when absent or unsafe. */
  callbackUrl?: string;
}

/**
 * Turns the Auth.js callback URL into the interstitial URL on the same
 * origin, carrying over token, email and callbackUrl. Throws when the input
 * is not the email callback, so a misconfiguration fails loudly instead of
 * sending a link that bypasses the interstitial.
 */
export function toInterstitialUrl(callbackUrl: string): string {
  const source = new URL(callbackUrl);
  if (source.pathname !== EMAIL_CALLBACK_PATH) {
    throw new Error("magic link: unexpected callback path");
  }
  const target = new URL(VERIFY_PATH, source.origin);
  for (const key of ["token", "email", "callbackUrl"] as const) {
    const value = source.searchParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
  return target.toString();
}

/**
 * Keeps a post-sign-in destination only if it stays on `origin`.
 * Returns a path (+ query/hash) or undefined.
 */
export function safeCallbackUrl(raw: string | null, origin: string): string | undefined {
  if (!raw || raw.length > MAX_CALLBACK_LENGTH) return undefined;
  // reject control chars and backslashes, which browsers normalise to "/"
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw, origin);
  } catch {
    return undefined;
  }
  if (parsed.origin !== new URL(origin).origin) return undefined;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Reads and validates the interstitial query. Returns null when the link is
 * malformed (missing or implausible token/email).
 */
export function parseVerifyParams(
  searchParams: URLSearchParams,
  origin: string,
): MagicLinkParams | null {
  const token = searchParams.get("token") ?? "";
  const email = searchParams.get("email") ?? "";
  if (!TOKEN_RE.test(token)) return null;
  if (
    email.length === 0 ||
    email.length > MAX_EMAIL_LENGTH ||
    !email.includes("@") ||
    /[\s\u0000-\u001f\u007f<>]/.test(email)
  ) {
    return null;
  }
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"), origin);
  return callbackUrl ? { token, email, callbackUrl } : { token, email };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Headers for the interstitial response. */
export const VERIFY_PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

/**
 * The interstitial HTML. No script, no automatic redirect, no prefetchable
 * link to the callback: the token only travels when the user submits the form.
 */
export function renderVerifyPage(params: MagicLinkParams | null): string {
  const body = params
    ? `<h1>Accedi a PCB Studio</h1>
      <p>Stai accedendo come <strong>${escapeHtml(params.email)}</strong>.</p>
      <form method="get" action="${EMAIL_CALLBACK_PATH}">
        <input type="hidden" name="token" value="${escapeHtml(params.token)}">
        <input type="hidden" name="email" value="${escapeHtml(params.email)}">
        ${
          params.callbackUrl
            ? `<input type="hidden" name="callbackUrl" value="${escapeHtml(params.callbackUrl)}">`
            : ""
        }
        <button type="submit">Accedi</button>
      </form>
      <p class="note">Se non hai richiesto tu l'accesso, chiudi questa pagina.</p>`
    : `<h1>Link non valido</h1>
      <p>Il link di accesso è incompleto o non valido.</p>
      <p><a href="/login">Richiedi un nuovo link</a></p>`;

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Accedi a PCB Studio</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f8; --card:#fff; --text:#111827; --muted:#6b7280; --brand:#059669; --brand-strong:#047857; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0f0e; --card:#151a19; --text:#f3f4f6; --muted:#9ca3af; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:24px 16px; background:var(--bg); color:var(--text); font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { width:100%; max-width:380px; background:var(--card); border-radius:12px; padding:24px; box-shadow:0 1px 3px rgb(0 0 0 / .08); text-align:center; }
  h1 { margin:0 0 12px; font-size:20px; }
  p { margin:0 0 16px; font-size:14px; line-height:1.5; color:var(--muted); overflow-wrap:anywhere; }
  strong { color:var(--text); }
  button { width:100%; border:0; border-radius:8px; padding:12px 16px; font:600 15px system-ui,sans-serif; background:var(--brand); color:#fff; cursor:pointer; }
  button:hover { background:var(--brand-strong); }
  form { margin:0 0 16px; }
  .note { font-size:12px; margin:0; }
  a { color:var(--brand); }
</style>
</head>
<body>
<main>
      ${body}
</main>
</body>
</html>`;
}

/** Italian message for the `?error=` code Auth.js appends to /login. */
export function loginErrorMessage(code: string): string {
  if (code === "Verification") {
    return "Il link di accesso è già stato usato o è scaduto: richiedine uno nuovo qui sotto.";
  }
  return `Accesso non riuscito (${code}). Riprova.`;
}
