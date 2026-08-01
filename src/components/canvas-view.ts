"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Canvas view (schematic and routing): pan, zoom and framing.
 *
 * WHY A SINGLE PLACE. The zoom was written twice, and both copies were
 * missing the same thing: the wheel was listened to but not stopped, so
 * the browser applied its own zoom TOO and what grew was the page instead
 * of the board. On a Mac, trackpad pinch is not a separate gesture, it is
 * a wheel event with ctrlKey: without preventDefault there is no way to
 * keep it for yourself. And preventDefault only works on a non-passive
 * listener, which React does not guarantee: that is why the listener is
 * attached by hand.
 *
 * The keyboard shortcuts use + and - WITHOUT Cmd, because Cmd+/- belongs
 * to the browser and cannot be intercepted: the only honest way is to
 * offer a command that does not look like it.
 */

export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function useCanvasView({
  ref,
  min = 2,
  max = 600,
  onFit,
}: {
  ref: React.RefObject<HTMLElement | null>;
  min?: number;
  max?: number;
  /** refits the view to the whole drawing: only the canvas knows how */
  onFit?: () => void;
}) {
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 20 });
  /** zoom rectangle in progress, in screen coordinates relative to the canvas */
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const marqueeFrom = useRef<{ x: number; y: number } | null>(null);
  const [zoomKey, setZoomKey] = useState(false);

  const clamp = useCallback((k: number) => Math.min(max, Math.max(min, k)), [min, max]);

  /** zooms in keeping the point under the cursor fixed */
  const zoomAt = useCallback(
    (px: number, py: number, factor: number) => {
      setView((v) => {
        const k = clamp(v.k * factor);
        if (k === v.k) return v;
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    },
    [clamp],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const r = ref.current?.getBoundingClientRect();
      zoomAt((r?.width ?? 800) / 2, (r?.height ?? 600) / 2, factor);
    },
    [ref, zoomAt],
  );

  /**
   * Brings a screen rectangle to fill the view. The math is done
   * entirely in screen coordinates, so it works both for the schematic
   * canvas (y down) and the copper one (y up).
   */
  const zoomToRect = useCallback(
    (rect: Rect) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r || rect.w < 4 || rect.h < 4) return;
      setView((v) => {
        const s = Math.min(r.width / rect.w, r.height / rect.h);
        const k = clamp(v.k * s);
        const applied = k / v.k;
        const rcx = rect.x + rect.w / 2;
        const rcy = rect.y + rect.h / 2;
        return {
          k,
          x: r.width / 2 - (rcx - v.x) * applied,
          y: r.height / 2 - (rcy - v.y) * applied,
        };
      });
    },
    [ref, clamp],
  );

  // wheel and pinch: stop them here, otherwise the page zooms
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = node.getBoundingClientRect();
      // pinch arrives as wheel+ctrl with small deltas: it must be amplified,
      // otherwise the gesture feels unresponsive
      const divisor = e.ctrlKey ? 120 : 400;
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY / divisor));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [ref, zoomAt]);

  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(t.tagName);
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.key === "z" || e.key === "Z") {
        if (!e.metaKey && !e.ctrlKey) setZoomKey(true);
        return;
      }
      if (e.metaKey || e.ctrlKey) return; // Cmd+/- still belongs to the browser
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.3); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1 / 1.3); }
      else if (e.key === "0") { e.preventDefault(); onFit?.(); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "z" || e.key === "Z") { setZoomKey(false); setMarquee(null); marqueeFrom.current = null; }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [zoomBy, onFit]);

  /** true if the gesture was consumed by the area zoom */
  const marqueeDown = useCallback(
    (clientX: number, clientY: number): boolean => {
      if (!zoomKey) return false;
      const r = ref.current?.getBoundingClientRect();
      if (!r) return false;
      marqueeFrom.current = { x: clientX - r.left, y: clientY - r.top };
      setMarquee({ x: marqueeFrom.current.x, y: marqueeFrom.current.y, w: 0, h: 0 });
      return true;
    },
    [zoomKey, ref],
  );

  const marqueeMove = useCallback(
    (clientX: number, clientY: number): boolean => {
      const from = marqueeFrom.current;
      if (!from) return false;
      const r = ref.current?.getBoundingClientRect();
      if (!r) return false;
      const x = clientX - r.left, y = clientY - r.top;
      setMarquee({
        x: Math.min(from.x, x),
        y: Math.min(from.y, y),
        w: Math.abs(x - from.x),
        h: Math.abs(y - from.y),
      });
      return true;
    },
    [ref],
  );

  const marqueeUp = useCallback((): boolean => {
    if (!marqueeFrom.current) return false;
    marqueeFrom.current = null;
    if (marquee) zoomToRect(marquee);
    setMarquee(null);
    return true;
  }, [marquee, zoomToRect]);

  return {
    view,
    setView,
    zoomAt,
    zoomBy,
    zoomToRect,
    /** the Z key is held down: the next drag frames an area */
    zoomKey,
    marquee,
    marqueeDown,
    marqueeMove,
    marqueeUp,
  };
}

/** area-zoom rectangle, to be drawn on top of the canvas */
export function MarqueeStyle(rect: Rect): React.CSSProperties {
  return {
    position: "absolute",
    left: rect.x,
    top: rect.y,
    width: rect.w,
    height: rect.h,
    border: "1px solid #3BE8B0",
    background: "rgba(59,232,176,0.10)",
    pointerEvents: "none",
  };
}
