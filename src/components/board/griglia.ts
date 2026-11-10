/**
 * The snap pitches of "Sposta". 0,125 is half of 0,25, for the fine placement
 * of small parts (Niccolo', 2026-11-10); 0,635 = 25 mil, 1,27 = 50 mil,
 * 2,54 = 100 mil. Every one is a multiple of a thousandth of a millimetre,
 * which is what a saved position keeps: nothing rounds a 0,125 step away.
 */
export const GRID_OPTIONS = [0.125, 0.25, 0.635, 1.27, 2.54] as const;
export const GRID_DEFAULT = 0.635;

/** the choice of this page, also when the browser refuses to store it (private mode) */
const inMemoria = new Map<string, number>();

const chiave = (progetto: string) => `pcb-studio-griglia:${progetto}`;

/** the pitch chosen last on this project in this browser, or the default */
export function grigliaSalvata(progetto: string | undefined, storage: Pick<Storage, "getItem"> | null): number {
  if (!progetto) return GRID_DEFAULT;
  const qui = inMemoria.get(progetto);
  if (qui !== undefined) return qui;
  if (!storage) return GRID_DEFAULT;
  try {
    const v = Number(storage.getItem(chiave(progetto)));
    return (GRID_OPTIONS as readonly number[]).includes(v) ? v : GRID_DEFAULT;
  } catch {
    return GRID_DEFAULT;
  }
}

export function salvaGriglia(progetto: string | undefined, mm: number, storage: Pick<Storage, "setItem"> | null): void {
  if (!progetto) return;
  inMemoria.set(progetto, mm);
  try {
    storage?.setItem(chiave(progetto), String(mm));
  } catch {
    // private mode, full storage: the choice cannot be kept
  }
  for (const f of ascoltatori) f();
}

/** the canvases redraw when the pitch is chosen (useSyncExternalStore) */
const ascoltatori = new Set<() => void>();
export function ascoltaGriglia(f: () => void): () => void {
  ascoltatori.add(f);
  return () => void ascoltatori.delete(f);
}
