/**
 * True when a key press belongs to what the person is typing, not to the
 * canvas shortcuts listening on the window.
 *
 * Checking only INPUT and TEXTAREA left three holes: a <select> (arrows change
 * the option AND moved the component), anything contenteditable, and an IME
 * composition still open, where the Enter or the letter that confirms a word
 * is not a shortcut. Chrome marks composition keys with keyCode 229 even when
 * isComposing is not set yet.
 */
export function isTypingTarget(
  e: Pick<KeyboardEvent, "target" | "isComposing"> & { keyCode?: number },
): boolean {
  if (e.isComposing || e.keyCode === 229) return true;
  const t = e.target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!t || typeof t !== "object") return false;
  if (typeof t.tagName === "string" && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return true;
  return t.isContentEditable === true;
}
