/**
 * A THROUGH VIA HAS A PAD ON EVERY COPPER LAYER.
 *
 * tscircuit writes a through via as `layers: ["top", "bottom"]`, and
 * circuit-json-to-gerber flashes the via pad only on the layers listed. So on
 * the inner layers the drilled barrel met the copper only where a pour
 * happened to cover it. Measured on BIRDY_BAT on 2026-10-20: a 0.25 mm via of
 * NetC28_2 sitting on the edge of its pour on inner2 kept copper on less than
 * three quarters of its wall (annular ring -0.035 mm), a VBAT via 0.013 mm.
 * Altium and KiCad give a via its pad on every layer it crosses, and the
 * imported boards were built that way.
 *
 * So, for the Gerber, a via that goes from top to bottom is drawn on every
 * copper layer of the board. On a layer where it belongs to the pour the pad
 * closes the ring; on a layer of another net the pour already keeps the via's
 * full diameter plus the clearance away from it (see viePassanti in
 * pours-recompute.ts), so the pad sits alone in its opening.
 */
type El = Record<string, unknown> & { type?: unknown };

export function stratiDiRame(numeroStrati: number): string[] {
  const n = Number.isFinite(numeroStrati) && numeroStrati >= 2 ? Math.floor(numeroStrati) : 2;
  return ["top", ...Array.from({ length: n - 2 }, (_, i) => `inner${i + 1}`), "bottom"];
}

export function viePassantiSuOgniStrato<T extends El>(circuitJson: T[]): T[] {
  const scheda = circuitJson.find((el) => el.type === "pcb_board") as El | undefined;
  const strati = stratiDiRame(Number(scheda?.num_layers ?? 2));
  if (strati.length <= 2) return circuitJson;
  return circuitJson.map((el) => {
    if (el.type !== "pcb_via") return el;
    const l = Array.isArray(el.layers) ? (el.layers as unknown[]).map(String) : [];
    if (!(l.includes("top") && l.includes("bottom"))) return el; // blind or buried: as it is
    return { ...el, layers: strati };
  });
}
