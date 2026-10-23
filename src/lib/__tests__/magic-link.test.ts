import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/auth/verify/route";
import {
  EMAIL_CALLBACK_PATH,
  VERIFY_PATH,
  loginErrorMessage,
  parseVerifyParams,
  renderVerifyPage,
  safeCallbackUrl,
  toInterstitialUrl,
} from "@/lib/magic-link";

const ORIGIN = "https://pcb.example.com";
const TOKEN = "a".repeat(64);
const EMAIL = "valerio.scisci+pcb-magic-test@3bee.com";

/** The URL Auth.js hands to sendVerificationRequest. */
const authJsUrl = (callbackUrl = `${ORIGIN}/`) =>
  `${ORIGIN}${EMAIL_CALLBACK_PATH}?${new URLSearchParams({ callbackUrl, token: TOKEN, email: EMAIL })}`;

const verifyQuery = (extra: Record<string, string> = {}) =>
  new URLSearchParams({ token: TOKEN, email: EMAIL, ...extra });

describe("toInterstitialUrl", () => {
  it("points the email at the interstitial on the same origin, not at the callback", () => {
    const link = new URL(toInterstitialUrl(authJsUrl()));
    expect(link.origin).toBe(ORIGIN);
    expect(link.pathname).toBe(VERIFY_PATH);
    expect(link.searchParams.get("token")).toBe(TOKEN);
    expect(link.searchParams.get("email")).toBe(EMAIL);
    expect(link.searchParams.get("callbackUrl")).toBe(`${ORIGIN}/`);
    expect(link.toString()).not.toContain("/api/auth/callback");
  });

  it("refuses anything that is not the Auth.js email callback", () => {
    expect(() => toInterstitialUrl(`${ORIGIN}/api/auth/callback/google?code=x`)).toThrow();
    expect(() => toInterstitialUrl(`${ORIGIN}/somewhere`)).toThrow();
  });
});

describe("safeCallbackUrl", () => {
  it("keeps same-origin destinations as a path", () => {
    expect(safeCallbackUrl("/", ORIGIN)).toBe("/");
    expect(safeCallbackUrl(`${ORIGIN}/projects/42?tab=pcb#x`, ORIGIN)).toBe("/projects/42?tab=pcb#x");
  });

  it("drops anything that would leave the origin", () => {
    expect(safeCallbackUrl("https://evil.example/", ORIGIN)).toBeUndefined();
    expect(safeCallbackUrl("//evil.example/", ORIGIN)).toBeUndefined();
    expect(safeCallbackUrl("/\\evil.example", ORIGIN)).toBeUndefined();
    expect(safeCallbackUrl("javascript:alert(1)", ORIGIN)).toBeUndefined();
    expect(safeCallbackUrl("https://pcb.example.com.evil.example/", ORIGIN)).toBeUndefined();
    expect(safeCallbackUrl("/ok\n", ORIGIN)).toBeUndefined();
    expect(safeCallbackUrl(null, ORIGIN)).toBeUndefined();
    expect(safeCallbackUrl("", ORIGIN)).toBeUndefined();
  });
});

describe("parseVerifyParams", () => {
  it("accepts a well-formed link", () => {
    expect(parseVerifyParams(verifyQuery({ callbackUrl: `${ORIGIN}/` }), ORIGIN)).toEqual({
      token: TOKEN,
      email: EMAIL,
      callbackUrl: "/",
    });
  });

  it("drops a foreign callbackUrl but keeps the sign-in usable", () => {
    expect(parseVerifyParams(verifyQuery({ callbackUrl: "https://evil.example/" }), ORIGIN)).toEqual({
      token: TOKEN,
      email: EMAIL,
    });
  });

  it("rejects missing or implausible token and email", () => {
    expect(parseVerifyParams(new URLSearchParams({ email: EMAIL }), ORIGIN)).toBeNull();
    expect(parseVerifyParams(new URLSearchParams({ token: TOKEN }), ORIGIN)).toBeNull();
    expect(parseVerifyParams(verifyQuery({ token: "short" }), ORIGIN)).toBeNull();
    expect(parseVerifyParams(verifyQuery({ token: `${TOKEN}"><x` }), ORIGIN)).toBeNull();
    expect(parseVerifyParams(verifyQuery({ email: "no-at-sign" }), ORIGIN)).toBeNull();
    expect(parseVerifyParams(verifyQuery({ email: "a@b.c<script>" }), ORIGIN)).toBeNull();
  });
});

describe("renderVerifyPage", () => {
  it("renders one button that submits to the fixed callback, with no script or auto-redirect", () => {
    const html = renderVerifyPage({ token: TOKEN, email: EMAIL, callbackUrl: "/projects" });
    expect(html).toContain(`<form method="get" action="${EMAIL_CALLBACK_PATH}">`);
    expect(html).toContain(`name="token" value="${TOKEN}"`);
    expect(html).toContain('name="callbackUrl" value="/projects"');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/http-equiv="refresh"/i);
    // the token never appears in a plain link a prefetcher could follow
    expect(html).not.toMatch(/href="[^"]*token=/);
  });

  it("escapes values it echoes back", () => {
    const html = renderVerifyPage({ token: TOKEN, email: `x"&'@y.z`, callbackUrl: "/a?b=1&c=\"" });
    expect(html).toContain("x&quot;&amp;&#39;@y.z");
    expect(html).toContain("/a?b=1&amp;c=&quot;");
  });

  it("explains an invalid link and offers a new one", () => {
    const html = renderVerifyPage(null);
    expect(html).toContain("Link non valido");
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("<form");
  });
});

describe("GET /auth/verify", () => {
  it("answers a scanner's GET without touching the token, with safe headers", async () => {
    const log = vi.spyOn(console, "log");
    const res = GET(new Request(`${ORIGIN}${VERIFY_PATH}?${verifyQuery({ callbackUrl: `${ORIGIN}/` })}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain(">Accedi</button>");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("answers 400 on a malformed link", async () => {
    const res = GET(new Request(`${ORIGIN}${VERIFY_PATH}?email=${encodeURIComponent(EMAIL)}`));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.text()).toContain("Link non valido");
  });
});

describe("loginErrorMessage", () => {
  it("tells the user a Verification failure means a used or expired link", () => {
    expect(loginErrorMessage("Verification")).toMatch(/già stato usato o è scaduto/);
    expect(loginErrorMessage("Verification")).toMatch(/richiedine uno nuovo/);
  });

  it("keeps the generic message for other codes", () => {
    expect(loginErrorMessage("AccessDenied")).toBe("Accesso non riuscito (AccessDenied). Riprova.");
  });
});
