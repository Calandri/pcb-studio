"use client";

import type { SelectionRect } from "./capture";

/**
 * "Click the broken thing": the area/element selector for the feedback
 * widget.
 * Drag a rectangle around the problem, or just click an element: either way
 * you get the component's tag, classes, xpath and text for the issue.
 */

export interface ComponentInfo {
  tag: string;
  id: string | null;
  classes: string[];
  xpath: string;
  text_content: string | null;
  attributes: Record<string, string>;
}

export interface SelectorResult {
  rect: SelectionRect | null;
  component: ComponentInfo | null;
}

const MIN_SIZE = 20;
const WIDGET_ATTR = "data-feedback-widget";
const OVERLAY_ID = "__feedback_selector_overlay";

export class AreaSelector {
  private overlay: HTMLDivElement | null = null;
  private selectionBox: HTMLDivElement | null = null;
  private hint: HTMLDivElement | null = null;
  private startX = 0;
  private startY = 0;
  private isDragging = false;
  private savedUserSelect = "";

  private boundPointerDown: (e: PointerEvent) => void;
  private boundPointerMove: (e: PointerEvent) => void;
  private boundPointerUp: (e: PointerEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundSelectStart: (e: Event) => void;

  constructor(
    private onComplete: (result: SelectorResult) => void,
    private onCancel: () => void,
  ) {
    this.boundPointerDown = this.handlePointerDown.bind(this);
    this.boundPointerMove = this.handlePointerMove.bind(this);
    this.boundPointerUp = this.handlePointerUp.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundSelectStart = (e: Event) => {
      e.preventDefault();
    };
  }

  start(): void {
    this.overlay = document.createElement("div");
    Object.assign(this.overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
      backgroundColor: "rgba(0, 0, 0, 0.25)",
      cursor: "crosshair",
      zIndex: "2147483646",
    });
    this.overlay.id = OVERLAY_ID;
    document.body.appendChild(this.overlay);

    this.hint = document.createElement("div");
    Object.assign(this.hint.style, {
      position: "fixed",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      color: "white",
      fontSize: "17px",
      fontWeight: "600",
      fontFamily: "inherit",
      textShadow: "0 1px 4px rgba(0,0,0,0.5)",
      pointerEvents: "none",
      zIndex: "2147483646",
      textAlign: "center",
      lineHeight: "1.4",
    });
    this.hint.innerHTML =
      "Disegna attorno al problema<br><span style='font-size:13px;opacity:0.8'>o clicca l'elemento direttamente · Esc per annullare</span>";
    document.body.appendChild(this.hint);

    this.selectionBox = document.createElement("div");
    Object.assign(this.selectionBox.style, {
      position: "fixed",
      border: "2px solid #3BE8B0",
      backgroundColor: "rgba(59, 232, 176, 0.10)",
      boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.25)",
      zIndex: "2147483646",
      display: "none",
      pointerEvents: "none",
    });
    document.body.appendChild(this.selectionBox);

    this.savedUserSelect = document.documentElement.style.userSelect;
    document.documentElement.style.userSelect = "none";
    document.addEventListener("selectstart", this.boundSelectStart, true);

    // capture phase: fires before any dismiss handlers of popups/modals
    window.addEventListener("pointerdown", this.boundPointerDown, true);
    window.addEventListener("pointermove", this.boundPointerMove, true);
    window.addEventListener("pointerup", this.boundPointerUp, true);
    document.addEventListener("keydown", this.boundKeyDown);
  }

  stop(): void {
    this.overlay?.remove();
    this.selectionBox?.remove();
    this.hint?.remove();
    this.overlay = null;
    this.selectionBox = null;
    this.hint = null;
    window.removeEventListener("pointerdown", this.boundPointerDown, true);
    window.removeEventListener("pointermove", this.boundPointerMove, true);
    window.removeEventListener("pointerup", this.boundPointerUp, true);
    document.removeEventListener("keydown", this.boundKeyDown);
    document.removeEventListener("selectstart", this.boundSelectStart, true);
    document.documentElement.style.userSelect = this.savedUserSelect;
    this.isDragging = false;
  }

  private handlePointerDown(e: PointerEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest?.(`[${WIDGET_ATTR}]`)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.isDragging = true;
    this.startX = e.clientX;
    this.startY = e.clientY;
    if (this.hint) this.hint.style.display = "none";
    if (this.selectionBox) {
      Object.assign(this.selectionBox.style, {
        left: `${e.clientX}px`,
        top: `${e.clientY}px`,
        width: "0px",
        height: "0px",
        display: "block",
      });
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.isDragging || !this.selectionBox) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const x = Math.min(e.clientX, this.startX);
    const y = Math.min(e.clientY, this.startY);
    Object.assign(this.selectionBox.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${Math.abs(e.clientX - this.startX)}px`,
      height: `${Math.abs(e.clientY - this.startY)}px`,
    });
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.isDragging) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.isDragging = false;

    const x = Math.min(e.clientX, this.startX);
    const y = Math.min(e.clientY, this.startY);
    const w = Math.abs(e.clientX - this.startX);
    const h = Math.abs(e.clientY - this.startY);

    if (this.overlay) this.overlay.style.display = "none";
    if (this.selectionBox) this.selectionBox.style.display = "none";

    if (w < MIN_SIZE || h < MIN_SIZE) {
      // plain click: identify the element under the point
      const el = document.elementFromPoint(this.startX, this.startY) as HTMLElement | null;
      const component = el && !el.closest(`[${WIDGET_ATTR}]`) ? buildComponentInfo(el) : null;
      this.stop();
      this.onComplete({ rect: null, component });
      return;
    }

    const centerX = x + w / 2;
    const centerY = y + h / 2;
    const el = document.elementFromPoint(centerX, centerY) as HTMLElement | null;
    const component = el && !el.closest(`[${WIDGET_ATTR}]`) ? buildComponentInfo(el) : null;
    this.stop();
    this.onComplete({ rect: { x, y, width: w, height: h }, component });
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      this.stop();
      this.onCancel();
    }
  }
}

function buildComponentInfo(el: HTMLElement): ComponentInfo {
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: Array.from(el.classList).slice(0, 12),
    xpath: getXPath(el),
    text_content: (el.textContent || "").trim().slice(0, 100) || null,
    attributes: getRelevantAttributes(el),
  };
}

function getXPath(el: HTMLElement): string {
  const parts: string[] = [];
  let node: HTMLElement | null = el;
  while (node && node.nodeType === Node.ELEMENT_NODE) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) {
      parts.unshift(node.tagName.toLowerCase());
      break;
    }
    const tagName = node.tagName;
    const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === tagName);
    const idx = siblings.indexOf(node) + 1;
    parts.unshift(siblings.length > 1 ? `${node.tagName.toLowerCase()}[${idx}]` : node.tagName.toLowerCase());
    node = parent;
  }
  return "/" + parts.join("/");
}

function getRelevantAttributes(el: HTMLElement): Record<string, string> {
  const result: Record<string, string> = {};
  const KEEP = ["name", "type", "role", "aria-label", "placeholder", "href", "src", "alt"];
  for (const attr of Array.from(el.attributes)) {
    if (KEEP.includes(attr.name) || attr.name.startsWith("data-")) {
      result[attr.name] = attr.value.slice(0, 100);
    }
  }
  return result;
}
