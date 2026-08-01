"use client";

import { snapdom } from "@zumer/snapdom";

/**
 * Page screenshot for the feedback widget.
 *
 * Why snapdom and not getDisplayMedia: the browser's "choose what to share"
 * picker is hostile UX for a feedback flow. The known failure modes of a
 * naive DOM capture are handled the standard way:
 *  - WebGL/canvas elements would come out black: each visible <canvas> is
 *    snapshotted to an <img> synchronously, before the next compositor flush.
 *  - vh-family sizes collapse inside the SVG viewport: they are frozen to
 *    computed px for the duration of the capture.
 *  - the widget's own UI must not photobomb: anything under
 *    [data-feedback-widget] is detached and restored after.
 */

export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WIDGET_ATTR = "data-feedback-widget";
const SELECTOR_OVERLAY_ID = "__feedback_selector_overlay";
const MAX_RENDER_AREA = 150_000_000;
const MAX_RENDER_DIM = 30_000;

/** full-viewport rect, for when the user did not select an area */
export function viewportRect(): SelectionRect {
  return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
}

export async function captureScreenshot(
  rect: SelectionRect,
  opts?: { maxWidth?: number; quality?: number },
): Promise<string> {
  const maxWidth = opts?.maxWidth ?? 1920;
  const quality = opts?.quality ?? 0.85;

  // 1. snapshot canvases synchronously (WebGL buffers vanish after a flush)
  const canvasReplacements = swapCanvasesForImages();

  const savedScrollX = window.scrollX;
  const savedScrollY = window.scrollY;
  const frozenVh = freezeViewportRelativeHeights();

  const internalDpr = window.devicePixelRatio || 1;
  const docElForScale = document.documentElement;
  const renderW = Math.max(docElForScale.scrollWidth, docElForScale.clientWidth);
  const renderH = Math.max(docElForScale.scrollHeight, docElForScale.clientHeight);
  const dpr = Math.min(
    internalDpr,
    2,
    Math.sqrt(MAX_RENDER_AREA / (renderW * renderH)),
    MAX_RENDER_DIM / Math.max(renderW, renderH),
  );

  if (savedScrollX || savedScrollY) {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
  }

  try {
    const hidden = hideWidgetElements();
    try {
      const result = await snapdom(document.documentElement, {
        scale: dpr / internalDpr,
        embedFonts: true,
        fast: true,
        backgroundColor: "#0B100F",
      });
      const fullCanvas = await result.toCanvas();

      const docEl = document.documentElement;
      const docW = Math.max(docEl.scrollWidth, docEl.clientWidth);
      const docH = Math.max(docEl.scrollHeight, docEl.clientHeight);
      const scaleX = fullCanvas.width / docW;
      const scaleY = fullCanvas.height / docH;

      const cropX = Math.max(0, Math.round((rect.x + savedScrollX) * scaleX));
      const cropY = Math.max(0, Math.round((rect.y + savedScrollY) * scaleY));
      const cropW = Math.max(1, Math.min(Math.round(rect.width * scaleX), fullCanvas.width - cropX));
      const cropH = Math.max(1, Math.min(Math.round(rect.height * scaleY), fullCanvas.height - cropY));

      const out = document.createElement("canvas");
      out.width = cropW;
      out.height = cropH;
      const octx = out.getContext("2d");
      if (!octx) throw new Error("no 2d context");
      octx.drawImage(fullCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      return canvasToBase64(out, maxWidth, quality);
    } finally {
      hidden.restore();
    }
  } finally {
    canvasReplacements.restore();
    frozenVh.restore();
    if (savedScrollX || savedScrollY) {
      window.scrollTo({ top: savedScrollY, left: savedScrollX, behavior: "instant" });
    }
  }
}

interface CanvasSwap {
  canvas: HTMLCanvasElement;
  img: HTMLImageElement;
  prevDisplay: string;
}

function swapCanvasesForImages(): { restore: () => void } {
  const swaps: CanvasSwap[] = [];
  for (const canvas of Array.from(document.querySelectorAll("canvas"))) {
    if (canvas.width === 0 || canvas.height === 0) continue;
    if (canvas.closest(`[${WIDGET_ATTR}]`)) continue;
    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL("image/png");
    } catch {
      continue; // tainted canvas
    }
    if (dataUrl.length < 200) continue;

    const cs = window.getComputedStyle(canvas);
    const img = new Image();
    img.src = dataUrl;
    img.width = canvas.width;
    img.height = canvas.height;
    Object.assign(img.style, {
      width: cs.width,
      height: cs.height,
      display: cs.display === "inline" ? "inline-block" : cs.display,
      position: cs.position,
      top: cs.top,
      left: cs.left,
      right: cs.right,
      bottom: cs.bottom,
      margin: cs.margin,
      transform: cs.transform === "none" ? "" : cs.transform,
      zIndex: cs.zIndex,
      objectFit: "fill",
    });

    const parent = canvas.parentNode;
    if (!parent) continue;
    const prevDisplay = canvas.style.display;
    canvas.style.display = "none";
    parent.insertBefore(img, canvas);
    swaps.push({ canvas, img, prevDisplay });
  }
  return {
    restore: () => {
      for (const s of swaps) {
        s.img.remove();
        s.canvas.style.display = s.prevDisplay;
      }
    },
  };
}

const VH_FREEZE_PROPS = ["height", "min-height", "max-height"] as const;
const VH_UNIT_RE = /\d*\.?\d+(?:vh|svh|lvh|dvh)\b/;

function freezeViewportRelativeHeights(): { restore: () => void } {
  const selectorProps = new Map<string, Set<string>>();
  const walkRules = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const props = new Set<string>();
        for (const prop of VH_FREEZE_PROPS) {
          if (VH_UNIT_RE.test(rule.style.getPropertyValue(prop))) props.add(prop);
        }
        if (props.size === 0) continue;
        for (const sel of rule.selectorText.split(",")) {
          const trimmed = sel.trim();
          if (!trimmed) continue;
          const existing = selectorProps.get(trimmed);
          if (existing) for (const p of props) existing.add(p);
          else selectorProps.set(trimmed, new Set(props));
        }
      } else if ("cssRules" in rule) {
        walkRules((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (sheet.cssRules) walkRules(sheet.cssRules);
    } catch {
      continue;
    }
  }

  const frozen: { el: HTMLElement; prop: string; value: string; priority: string }[] = [];
  for (const [selector, props] of selectorProps) {
    let elements: Element[];
    try {
      elements = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const el of elements) {
      if (!(el instanceof HTMLElement)) continue;
      const computed = window.getComputedStyle(el);
      for (const prop of props) {
        frozen.push({
          el,
          prop,
          value: el.style.getPropertyValue(prop),
          priority: el.style.getPropertyPriority(prop),
        });
        el.style.setProperty(prop, computed.getPropertyValue(prop));
      }
    }
  }
  return {
    restore: () => {
      for (const f of frozen) {
        if (f.value) f.el.style.setProperty(f.prop, f.value, f.priority);
        else f.el.style.removeProperty(f.prop);
      }
    },
  };
}

function hideWidgetElements(): { restore: () => void } {
  const detached: { el: HTMLElement; parent: ParentNode; nextSibling: ChildNode | null }[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${WIDGET_ATTR}], #${SELECTOR_OVERLAY_ID}`))) {
    if (!el.parentNode) continue;
    detached.push({ el, parent: el.parentNode, nextSibling: el.nextSibling });
    el.parentNode.removeChild(el);
  }
  return {
    restore: () => {
      for (const d of detached) {
        if (d.nextSibling && d.nextSibling.parentNode === d.parent) {
          d.parent.insertBefore(d.el, d.nextSibling);
        } else {
          d.parent.appendChild(d.el);
        }
      }
    },
  };
}

function canvasToBase64(canvas: HTMLCanvasElement, maxWidth: number, quality: number): string {
  if (canvas.width > maxWidth) {
    const ratio = maxWidth / canvas.width;
    const scaled = document.createElement("canvas");
    scaled.width = maxWidth;
    scaled.height = Math.round(canvas.height * ratio);
    scaled.getContext("2d")!.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    return scaled.toDataURL("image/jpeg", quality).replace(/^data:image\/jpeg;base64,/, "");
  }
  return canvas.toDataURL("image/jpeg", quality).replace(/^data:image\/jpeg;base64,/, "");
}
