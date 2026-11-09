"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { cleanSel, componentOfKey } from "@/lib/schematic-interaction";
import type { BoardTab } from "./Chrome";

/**
 * One selection for the board view, the schematic and the URL.
 *
 * The board picks PARTS by copper id (partId, which opens the part card); the
 * schematic selects parts, pins and nets by name ("U3", "U3.REFP", "VREF").
 * The shared value is the schematic's key, because it is the richer one: a
 * net selected on the schematic has no part to pick on the board, and the
 * board's pick is just the part's name.
 *
 * The key also lives in the URL (?sel=U3&tab=schematic), so a link opens the
 * view on that part. The URL is read after mount, not during render: the
 * server renders without it, and reading it earlier breaks hydration.
 */
const URL_TABS: readonly BoardTab[] = ["schematic", "pcb"];

export function useSharedSelection({
  parts,
  tab,
  setTab,
  partId,
  setPartId,
}: {
  parts: ReadonlyArray<{ id: string; name: string }>;
  tab: BoardTab;
  setTab: (tab: BoardTab) => void;
  partId: string | null;
  setPartId: (id: string | null) => void;
}) {
  const [selection, setSelection] = useState<string | null>(null);
  /** the URL has been read: before that, writing it would erase the link */
  const [urlRead, setUrlRead] = useState(false);

  useEffect(() => {
    /*
     * Once, after mount: the URL is the outside world here, and it cannot be
     * read during render without breaking hydration. Later the URL follows
     * the state, not the other way round.
     */
    const params = new URLSearchParams(window.location.search);
    const sel = cleanSel(params.get("sel"));
    const wanted = params.get("tab");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrlRead(true);
    if (!sel) return;
    setSelection(sel);
    setTab(URL_TABS.find((t) => t === wanted) ?? "schematic");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!urlRead) return;
    const url = new URL(window.location.href);
    if (selection) {
      url.searchParams.set("sel", selection);
      if (URL_TABS.includes(tab)) url.searchParams.set("tab", tab);
      else url.searchParams.delete("tab");
    } else {
      url.searchParams.delete("sel");
      url.searchParams.delete("tab");
    }
    // replace, not push: every click is not a step back in the history
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [urlRead, selection, tab]);

  const names = useMemo(() => new Set(parts.map((p) => p.name)), [parts]);

  /*
   * A selection from the link: the board picks its part once the parts are
   * known. Once per selection, so closing the card does not reopen it; set
   * during render (not in an effect) so the card never shows a frame late.
   */
  const [pickedFor, setPickedFor] = useState<string | null>(null);
  if (selection && selection !== pickedFor && names.size > 0) {
    setPickedFor(selection);
    const name = componentOfKey(selection, names);
    const part = name ? parts.find((p) => p.name === name) : undefined;
    if (part && !partId) setPartId(part.id);
  }

  /** the board picked a part (or nothing) */
  const pickPart = useCallback(
    (id: string | null) => {
      setPartId(id);
      setSelection(id ? (parts.find((p) => p.id === id)?.name ?? null) : null);
    },
    [parts, setPartId],
  );

  /** the schematic selected something: the board picks its part, if it has one */
  const selectFromSchematic = useCallback(
    (key: string | null, component: string | null) => {
      setSelection(key);
      setPartId(component ? (parts.find((p) => p.name === component)?.id ?? null) : null);
    },
    [parts, setPartId],
  );

  return { selection, pickPart, selectFromSchematic };
}
