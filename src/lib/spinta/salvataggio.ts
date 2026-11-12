/**
 * FROM THE COPPER A MOVE LEFT TO THE ENTRIES OF manual-edits.json, AND BACK.
 *
 * Copper the FILES draw is saved as CORRECTIONS (see ManualRoute.replaces
 * and ManualViaMove in manual-routes.ts): they are what the action `copper` of
 * /api/manual-edits reads (leggiRame), checks on the saved board (verificaRame)
 * and what applyManualRoutes lays, in a compile as in the fast update.
 *
 *   - every trace of the files the move touched: a route with `replaces`. Its connection by
 *     the names of part and pin, its whole path with the layer of every point
 *     and the vias in their place, its width, the size of its vias, and the
 *     path it had WHEN THE GESTURE BEGAN (`replaces.original`): that is what
 *     tells which trace of the connection it is, and what an undo puts back;
 *   - every lone via the move took: an entry of `pcb_vias`, with its net by
 *     name, where it was, where it is, its hole, its ring and its layers. A via
 *     a trace changes layer in has no entry: it travels with the path of its
 *     trace.
 *
 * Copper that is ALREADY A HAND ROUTE of the file (drawn in Instrada, imported
 * from another CAD) is not corrected: its route is REWRITTEN in its place. Of
 * such a trace only the key of its route (which its copper carries) and its
 * new path are given (riscritteDellaMossa): whoever writes the file keeps every
 * other field of the route as the file has it. The via such a route changes
 * layer in has no entry anywhere: it is laid wherever the route changes layer.
 *
 * Nothing numbered at a compile is written: no id of the circuit.
 *
 * Whoever copies a correction into the sources of a project (the agents that
 * generate them) reads these same fields.
 */
import type { CopperPatch } from "../manual-edits";
import { stessoPercorso, type ManualRoute, type ManualRoutePoint, type ManualViaMove } from "../manual-routes";
import type { Modello } from "./modello";
import type { PistaMossa, RameMosso, ViaMossa } from "./mosse";

const punto = (p: ManualRoutePoint): ManualRoutePoint => ({ x: p.x, y: p.y, layer: p.layer });

/** where a path changes layer, in order: the places of its vias */
const cambiDiStrato = (punti: readonly ManualRoutePoint[]): ManualRoutePoint[] => punti.filter((p, i) => i > 0 && punti[i - 1].layer !== p.layer);

/**
 * The corrections of one gesture: what a move (or several moves of one drag,
 * each trace and each via once) left of the copper of the FILES, on the model
 * the gesture began on. The hand routes it touched are not here: see
 * riscritteDellaMossa.
 *
 * `gesto`: the name of the drag, the same on all of them (letters, digits, _
 * and -, at most 64). `quando`: the instant, ISO 8601; the server writes its
 * own on what it saves.
 */
export function correzioniDellaMossa(
  modello: Modello,
  mossa: Pick<RameMosso, "piste" | "vie">,
  gesto: string,
  quando?: string,
): CopperPatch {
  const delGesto = { gesto, ...(quando ? { at: quando } : {}) };
  const routes: ManualRoute[] = mossa.piste.filter(({ pista }) => modello.piste[pista].aMano === null).map(({ pista, punti }) => {
    const p = modello.piste[pista];
    return {
      connection: p.connessione,
      points: punti.map(punto),
      width: p.larghezza,
      // the holes of the trace keep their size: said here, so that whoever copies the correction need not read the board
      ...(p.via ? { viaDiameter: p.via.diametro, viaHoleDiameter: p.via.foro } : {}),
      replaces: { original: p.punti.map(punto), width: p.larghezza },
      ...delGesto,
    };
  });
  // a via of the files no trace changes layer in; any other travels with the paths of its traces
  const vias: ManualViaMove[] = mossa.vie
    .filter(({ via }) => !modello.vie[via].diPista && !modello.vie[via].aMano)
    .map(({ via, da, a }) => {
      const v = modello.vie[via];
      return {
        net: v.nomeRete,
        from: { x: da.x, y: da.y },
        to: { x: a.x, y: a.y },
        holeDiameter: v.foro,
        outerDiameter: v.corona,
        layers: [...v.strati],
        ...delGesto,
      };
    });
  return { routes, vias };
}

/**
 * The hand routes one gesture rewrites: for every trace the move touched that
 * is the copper of a hand route, the key of that route as the file holds it
 * and its new path, on whole microns. The route itself is not rebuilt: its
 * copper does not say all of it, and the file does.
 */
export function riscritteDellaMossa(modello: Modello, mossa: Pick<RameMosso, "piste">): Array<{ chiave: string; points: ManualRoutePoint[] }> {
  return mossa.piste.flatMap(({ pista, punti }) => {
    const chiave = modello.piste[pista].aMano;
    return chiave === null ? [] : [{ chiave, points: punti.map(punto) }];
  });
}

/** the copper some corrections stand for, on a model: which of its traces and vias, and where they go */
export interface RameDelleCorrezioni {
  piste: PistaMossa[];
  vie: ViaMossa[];
  /** the corrections whose copper is not on this model: another board, or one that already shows them */
  nonTrovate: CopperPatch;
}

/**
 * The way back: corrections as copper on a model, to draw them before the
 * saved board shows them, or to draw an undo.
 *
 *   - "posate" (laid): the model is the board the gesture began on. Each trace
 *     is found by its connection and the path it had (`replaces.original`), and
 *     goes to the path of the route; each via by its net and where it was
 *     (`from`), and goes to `to`;
 *   - "tolte" (taken away): the model is the board that shows them. Each trace
 *     is found on the path of the route and goes back to `replaces.original`,
 *     each via in `to` and goes back to `from`.
 *
 * A via a trace changes layer in is in no entry of `pcb_vias`: it is read from
 * the two paths of its trace, where the change of layer was and where it is.
 *
 * A route with no points takes its trace out: laid, the trace has no path.
 */
export function rameDelleCorrezioni(modello: Modello, rame: CopperPatch, verso: "posate" | "tolte" = "posate"): RameDelleCorrezioni {
  const esito: RameDelleCorrezioni = { piste: [], vie: [], nonTrovate: { routes: [], vias: [] } };
  const prese = new Set<number>();
  const viePrese = new Set<number>();
  for (const route of rame.routes) {
    if (!route.replaces) {
      esito.nonTrovate.routes.push(route);
      continue;
    }
    const [da, a] = verso === "posate" ? [route.replaces.original, route.points] : [route.points, route.replaces.original];
    const pista = modello.piste.find((p) => !prese.has(p.indice) && p.connessione === route.connection && stessoPercorso(p.punti, da));
    if (!pista) {
      esito.nonTrovate.routes.push(route);
      continue;
    }
    prese.add(pista.indice);
    esito.piste.push({ pista: pista.indice, punti: a.map(punto) });
    // the vias the trace changes layer in travel with its path: the ones that are not where they were
    const erano = cambiDiStrato(da);
    const sono = cambiDiStrato(a);
    if (erano.length !== sono.length) continue;
    for (const [i, era] of erano.entries()) {
      if (era.x === sono[i].x && era.y === sono[i].y) continue;
      const via = modello.vie.find((v) => !viePrese.has(v.indice) && v.diPista && v.x === era.x && v.y === era.y);
      if (!via) continue;
      viePrese.add(via.indice);
      esito.vie.push({ via: via.indice, da: { x: era.x, y: era.y }, a: { x: sono[i].x, y: sono[i].y } });
    }
  }
  for (const mossa of rame.vias) {
    const [da, a] = verso === "posate" ? [mossa.from, mossa.to] : [mossa.to, mossa.from];
    const via = modello.vie.find((v) => !viePrese.has(v.indice) && !v.diPista && v.nomeRete === mossa.net && v.x === da.x && v.y === da.y);
    if (!via) {
      esito.nonTrovate.vias.push(mossa);
      continue;
    }
    viePrese.add(via.indice);
    esito.vie.push({ via: via.indice, da: { x: da.x, y: da.y }, a: { x: a.x, y: a.y } });
  }
  return esito;
}
