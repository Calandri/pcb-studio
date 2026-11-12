/**
 * THE GESTURE THAT MOVES COPPER IN "SPOSTA", as the viewer and the solver agree
 * on it. Types only: the viewer draws from them and the solver fills them, and
 * neither knows how the other is made.
 *
 * The functions are in gesto.ts:
 *   - preseDelRame(circuitJson): what can be grabbed on a board;
 *   - iniziaGesto({ circuitJson, regole, presa }): the gesture starts;
 *   - muoviGesto(gesto, verso): where the copper stands with the pointer at
 *     `verso`, always worked out from the START of the gesture;
 *   - chiudiGesto(gesto, stato, gestoId): what to save, or null when nothing
 *     moved.
 *
 * Coordinates are mm, board center = (0; 0), as in the Circuit JSON.
 */
import type { ManualRoute, ManualRoutePoint, ManualViaMove } from "../manual-routes";

/** what the pointer can grab: a via, or one straight stretch of a trace */
export type PresaDelRame =
  | { tipo: "via"; pcbViaId: string }
  | {
      tipo: "tratto";
      pcbTraceId: string;
      /** the index, in the `route` of the pcb_trace, of the point the stretch starts from (it ends at the next) */
      indice: number;
    };

/** a thing that can be grabbed, with where it is: the viewer puts a hit target on it */
export type BersaglioDelRame =
  | { tipo: "via"; pcbViaId: string; x: number; y: number; outerDiameter: number }
  | {
      tipo: "tratto";
      pcbTraceId: string;
      indice: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      layer: string;
      width: number;
    };

/** one straight stretch of moved copper, as it is drawn while the gesture lasts */
export interface TrattoInMovimento {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  layer: string;
  width: number;
}

/** a moved via, as it is drawn while the gesture lasts: a through hole, on every layer */
export interface ViaInMovimento {
  x: number;
  y: number;
  outerDiameter: number;
  holeDiameter: number;
}

/** what stops the gesture: the sentence for the person, and what to light up on the board */
export interface BloccoDelGesto {
  /** in Italian, short, naming the thing: "bloccato dalla piazzola R3.1", "la pista SDA non ha spazio" */
  motivo: string;
  /** the thing that blocks, where it is: the viewer draws a halo there */
  alone?: { x: number; y: number; raggioMm: number; layer?: string };
}

/** where the copper of a gesture stands, for one position of the pointer */
export interface StatoDelGesto {
  /**
   * The pcb_trace and pcb_via the gesture touches: the still copper leaves
   * them out while it lasts, and `tratti` and `vie` are drawn in their place.
   * The same lists for every position of one gesture.
   */
  nascosti: { pcbTraceIds: string[]; pcbViaIds: string[] };
  /** all the copper of the hidden traces as it stands now, stretch by stretch */
  tratti: TrattoInMovimento[];
  /** all the hidden vias where they stand now */
  vie: ViaInMovimento[];
  /** where the grabbed thing is: the pointer's place when free, the last good place when blocked */
  posizione: { x: number; y: number };
  /** null while the copper follows the pointer */
  blocco: BloccoDelGesto | null;
  /** whether anything stands elsewhere than at the start of the gesture */
  mosso: boolean;
}

/**
 * What a finished gesture asks to be saved, as the action `copper` of
 * /api/manual-edits takes it (with `projectId` and `gesto` next to it).
 */
export interface SalvataggioDelGesto {
  /** corrections of the files' copper: routes with `replaces` (see ManualRoute.replaces) */
  routes: ManualRoute[];
  /** lone vias of the files, moved (see ManualViaMove) */
  vias: ManualViaMove[];
  /**
   * Copper that is already a hand route of manual-edits.json (drawn in
   * Instrada, or imported from another CAD: the pcb_trace is `manual` and
   * carries `manual_route_id`, with no `replaces`): the route is rewritten in
   * its place. `chiave` is the key of the route as it is in the file
   * (manualRouteKey, the `manual_route_id` of its copper), `points` its path
   * as it is now, on the 0.001 mm grid the hand routes are read on.
   *
   * Nothing else travels: the server keeps every other field of the route
   * (connection, pads, net, widths, via sizes) from the file, so nothing about
   * it is taken from the page and nothing has to be guessed from the copper.
   */
  riscritte: Array<{ chiave: string; points: ManualRoutePoint[] }>;
}
