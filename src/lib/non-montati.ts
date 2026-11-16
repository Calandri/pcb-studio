/**
 * PARTS THAT ARE NOT MOUNTED. A part written with `doNotPlace` (tscircuit)
 * leaves its pads, holes and silkscreen on the board but no component: the
 * Tag-Connect TC2030-NL of sbb-dl-principale (J5) is only a footprint the
 * programming cable presses on. The Circuit JSON says it on the part's
 * `pcb_component.do_not_place`.
 *
 * Until 16/11/2026 nothing read it: J5 went to the pick-and-place file and to
 * the BOM, and PCB Basic, who assembles the boards, would have been asked to
 * place a part that does not exist. Such parts now stay out of both and go to
 * a file of their own (see buildNonMontati in bom.ts).
 *
 * Kept apart from bom.ts so the viewer can count them without the exporters.
 */

type El = { type?: unknown; [k: string]: unknown };

/** the pcb_component of a part that is not mounted */
export const eNonMontato = (el: unknown): boolean =>
  typeof el === "object" &&
  el !== null &&
  (el as El).type === "pcb_component" &&
  (el as El).do_not_place === true;

/** names of the parts that are not mounted, as the designators of the BOM and the pick and place write them */
export function nomiNonMontati(circuitJson: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const el of circuitJson) {
    const id = eNonMontato(el) ? (el as El).source_component_id : undefined;
    if (typeof id === "string" && id) ids.add(id);
  }
  const nomi = new Set<string>();
  if (ids.size === 0) return nomi;
  for (const el of circuitJson as El[]) {
    if (el?.type === "source_component" && ids.has(String(el.source_component_id ?? "")) && el.name) {
      nomi.add(String(el.name));
    }
  }
  return nomi;
}
