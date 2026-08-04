import type { ManualRoute } from "./manual-routes";

/**
 * LE CLASSI DEL RAME: le misure che una scheda usa davvero, contate.
 *
 * Un minimo di fabbricazione dice cosa il fornitore riesce a fare; non dice di
 * che misura sono le via di questa scheda, e soprattutto non le cambia. Chi
 * disegna non ragiona per minimi: ragiona per FAMIGLIE — la via piccola dei
 * segnali, quella grande dell'alimentazione, la pista sottile sotto il BGA,
 * quella larga della batteria — e quando ne cambia una la cambia tutta insieme.
 *
 * Le famiglie non si inventano: si leggono dal rame che c'e'. Su una scheda
 * importata sono le stesse che il progettista ha usato in Altium (BAT_BS: 510
 * via da 0.5/0.15 e 126 da 0.6/0.25, piste a 6, 8, 10, 12, 20 e 50 mil), e su
 * una disegnata qui sono quelle che l'instradatore ha posato. In tutti e due i
 * casi il conto e' la verita' del momento, non una dichiarazione.
 *
 * Il senso di raggrupparle e' poterle cambiare in blocco: "porta la via piccola
 * a sei mil" tocca 510 via e non 636, e lascia stare la grande, che e' un'altra
 * scelta di progetto.
 */

/** la tolleranza con cui due misure sono la stessa misura: un micron */
const UGUALE_MM = 0.0005;

export interface ClasseVia {
  padMm: number;
  foroMm: number;
  /** quante via hanno questa misura */
  quante: number;
  /** il rame che resta attorno al foro: la misura che rompe, non il pad */
  coronaMm: number;
}

export interface ClassePista {
  larghezzaMm: number;
  /** quanti tratti, e quanto rame in tutto */
  quanti: number;
  lunghezzaMm: number;
}

export interface ClassiRame {
  via: ClasseVia[];
  piste: ClassePista[];
}

/** una rotta di due punti nello stesso posto su due facce e' una via, non una pista */
const eUnaVia = (r: ManualRoute): boolean =>
  r.points.length === 2 &&
  Math.abs(r.points[0].x - r.points[1].x) < 1e-6 &&
  Math.abs(r.points[0].y - r.points[1].y) < 1e-6;

const r4 = (n: number) => Number(n.toFixed(4));

/** le famiglie di misure che questo rame usa, dalla piu' usata alla meno */
export function classiDalRame(routes: ManualRoute[]): ClassiRame {
  const via = new Map<string, ClasseVia>();
  const piste = new Map<string, ClassePista>();

  for (const r of routes) {
    if (eUnaVia(r)) {
      const padMm = r4(r.viaDiameter ?? 0);
      const foroMm = r4(r.viaHoleDiameter ?? 0);
      if (padMm <= 0 || foroMm <= 0) continue;
      const k = `${padMm}/${foroMm}`;
      const c = via.get(k) ?? { padMm, foroMm, quante: 0, coronaMm: r4((padMm - foroMm) / 2) };
      c.quante++;
      via.set(k, c);
      continue;
    }
    const larghezzaMm = r4(r.width ?? 0);
    if (larghezzaMm <= 0) continue;
    let lung = 0;
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1];
      const b = r.points[i];
      if (a.layer !== b.layer) continue;
      lung += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const c = piste.get(String(larghezzaMm)) ?? { larghezzaMm, quanti: 0, lunghezzaMm: 0 };
    c.quanti++;
    c.lunghezzaMm = r4(c.lunghezzaMm + lung);
    piste.set(String(larghezzaMm), c);
  }

  return {
    via: [...via.values()].sort((a, b) => a.foroMm - b.foroMm),
    piste: [...piste.values()].sort((a, b) => a.larghezzaMm - b.larghezzaMm),
  };
}

export interface CambioVia {
  da: { padMm: number; foroMm: number };
  a: { padMm: number; foroMm: number };
}

export interface CambioPista {
  daMm: number;
  aMm: number;
}

export interface EsitoCambio {
  routes: ManualRoute[];
  viaCambiate: number;
  pisteCambiate: number;
}

const stessaMisura = (a: number, b: number) => Math.abs(a - b) < UGUALE_MM;

/**
 * Cambia una famiglia intera.
 *
 * Non tocca nient'altro: le via di un'altra misura restano dove sono, e il rame
 * che non e' della famiglia non viene neanche letto. E' l'unico modo in cui una
 * modifica di massa resta una cosa che si puo' spiegare — "ho portato la via
 * piccola da 0.15 a 0.1524, sono 510" — invece di una scheda che cambia sotto
 * le mani.
 */
export function applicaClassi(
  routes: ManualRoute[],
  cambi: { via?: CambioVia[]; piste?: CambioPista[] },
): EsitoCambio {
  let viaCambiate = 0;
  let pisteCambiate = 0;

  const fuori = routes.map((r) => {
    if (eUnaVia(r)) {
      const pad = r.viaDiameter ?? 0;
      const foro = r.viaHoleDiameter ?? 0;
      const c = (cambi.via ?? []).find(
        (x) => stessaMisura(x.da.padMm, pad) && stessaMisura(x.da.foroMm, foro),
      );
      if (!c) return r;
      viaCambiate++;
      return { ...r, viaDiameter: r4(c.a.padMm), viaHoleDiameter: r4(c.a.foroMm) };
    }
    const c = (cambi.piste ?? []).find((x) => stessaMisura(x.daMm, r.width ?? 0));
    if (!c) return r;
    pisteCambiate++;
    return { ...r, width: r4(c.aMm) };
  });

  return { routes: fuori, viaCambiate, pisteCambiate };
}
