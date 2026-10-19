/**
 * What the feedback screenshot must never show.
 *
 * The screenshot becomes a PUBLIC GitHub issue, and its bytes are served to
 * anyone with the link. The page it is taken from can show secrets in clear: a
 * freshly generated MCP token stays on /org until "Ho copiato" is pressed, and
 * a single "Feedback" click in that moment published it. Two defenses: any node
 * marked with `data-feedback-redact` (and any password field) is replaced by a
 * placeholder IN THE CLONE the screenshot is drawn from, so the live page does
 * not flicker; and on pages that handle keys and tokens the screenshot starts
 * unchecked, so attaching one is a choice and not a default.
 */

export const REDACT_ATTR = "data-feedback-redact";

/** the pages where people manage members, tokens and API keys */
const SENSITIVE_PATH = /^\/(org|team)(\/|$)/;

/** the minimal element shape the rules below look at (testable without a DOM) */
interface ElementLike {
  tagName: string;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
}

/** a node whose content must not reach the screenshot */
export function isRedacted(el: ElementLike): boolean {
  if (el.hasAttribute(REDACT_ATTR)) return true;
  return el.tagName === "INPUT" && (el.getAttribute("type") ?? "").toLowerCase() === "password";
}

/** whether the "attach screenshot" box starts checked */
export function screenshotByDefault(pathname: string, pageShowsSecrets: boolean): boolean {
  return !pageShowsSecrets && !SENSITIVE_PATH.test(pathname);
}

/** the page currently shows something marked as secret (or a password field) */
export function pageShowsSecrets(doc: Document): boolean {
  return Boolean(doc.querySelector(`[${REDACT_ATTR}], input[type="password" i]`));
}

/**
 * The redacted nodes that will be drawn: the outermost ones (a marked node
 * inside a marked node disappears with its parent) that have a box on screen.
 * The capture checks that every one of them went through the placeholder, and
 * drops the screenshot otherwise: a redaction that silently did not happen is
 * worse than no screenshot.
 */
export function visibleRedactedNodes(root: Element): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(
    root.querySelectorAll(`[${REDACT_ATTR}], input[type="password" i]`),
  )) {
    let parent = el.parentElement;
    let nested = false;
    while (parent) {
      if (isRedacted(parent)) {
        nested = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (nested) continue;
    if (el.getClientRects().length === 0) continue;
    out.push(el);
  }
  return out;
}

/** what stands where the secret was, in the clone */
export function redactionPlaceholder(doc: Document): HTMLElement {
  const ph = doc.createElement("span");
  ph.textContent = "•••• nascosto nello screenshot";
  ph.setAttribute("aria-hidden", "true");
  return ph;
}

/**
 * Encodes at decreasing quality, then at decreasing width, until the result
 * fits the limit the server accepts. An oversized screenshot used to make the
 * whole feedback fail with "dati non validi", which said nothing about why.
 * Throws when even the smallest attempt does not fit.
 */
export function encodeUnderLimit(
  encode: (width: number, quality: number) => string,
  startWidth: number,
  quality: number,
  maxChars: number,
): string {
  const ladder = [...new Set([quality, 0.6, 0.45, 0.3].filter((q) => q <= quality))];
  let width = Math.max(1, Math.round(startWidth));
  for (;;) {
    for (const q of ladder) {
      const out = encode(width, q);
      if (out.length <= maxChars) return out;
    }
    const smaller = Math.round(width * 0.75);
    if (smaller < 240 || smaller === width) break;
    width = smaller;
  }
  throw new Error("screenshot troppo grande anche ridotto");
}
