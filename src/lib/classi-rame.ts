import { eMassa, ePotenza } from "./net-roles";
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
  /** come si chiama: quello scritto a mano, o quello che si vede dalle reti */
  nome: string;
}

export interface ClassePista {
  larghezzaMm: number;
  /** quanti tratti, e quanto rame in tutto */
  quanti: number;
  lunghezzaMm: number;
  nome: string;
}

/** i nomi che l'utente ha dato, agganciati alla misura */
export interface NomiDelleClassi {
  via?: Array<{ padMm: number; foroMm: number; nome: string }>;
  piste?: Array<{ larghezzaMm: number; nome: string }>;
}

export const CLASSI_PATH = "classi-rame.json";

/**
 * COME SI CHIAMA UNA FAMIGLIA, quando nessuno le ha dato un nome.
 *
 * Non dalla misura — "0.15" non dice niente a nessuno — ma da quello che ci
 * passa dentro: si guarda la rete di ogni pezzo e si vede se quella misura la
 * usano le masse, le alimentazioni o i segnali. E' la stessa distinzione che
 * fanno i controlli elettrici, con lo stesso classificatore, cosi' due parti
 * dell'app non chiamano potenza cose diverse.
 *
 * Quando due famiglie hanno lo stesso ruolo si distinguono per misura, in mils,
 * perche' e' cosi' che le chiama chi disegna: "la sei mil".
 */
function ruoloDelle(reti: string[]): "massa" | "potenza" | "segnale" {
  let massa = 0;
  let potenza = 0;
  for (const n of reti) {
    if (eMassa(n)) massa++;
    else if (ePotenza(n)) potenza++;
  }
  if (massa > reti.length / 2) return "massa";
  if (massa + potenza > reti.length / 2) return "potenza";
  return "segnale";
}

const inMil = (mm: number) => {
  const v = mm / 0.0254;
  return `${Number(v.toFixed(v < 10 ? 1 : 0))} mil`;
};

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
export function classiDalRame(
  routes: ManualRoute[],
  nomi: NomiDelleClassi = {},
): ClassiRame {
  const via = new Map<string, ClasseVia>();
  const piste = new Map<string, ClassePista>();
  const retiVia = new Map<string, string[]>();
  const retiPista = new Map<string, string[]>();

  for (const r of routes) {
    if (eUnaVia(r)) {
      const padMm = r4(r.viaDiameter ?? 0);
      const foroMm = r4(r.viaHoleDiameter ?? 0);
      if (padMm <= 0 || foroMm <= 0) continue;
      const k = `${padMm}/${foroMm}`;
      const c = via.get(k) ?? {
        padMm,
        foroMm,
        quante: 0,
        coronaMm: r4((padMm - foroMm) / 2),
        nome: "",
      };
      c.quante++;
      via.set(k, c);
      retiVia.set(k, [...(retiVia.get(k) ?? []), String(r.net ?? "")]);
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
    const c = piste.get(String(larghezzaMm)) ?? {
      larghezzaMm,
      quanti: 0,
      lunghezzaMm: 0,
      nome: "",
    };
    c.quanti++;
    c.lunghezzaMm = r4(c.lunghezzaMm + lung);
    piste.set(String(larghezzaMm), c);
    retiPista.set(String(larghezzaMm), [
      ...(retiPista.get(String(larghezzaMm)) ?? []),
      String(r.net ?? ""),
    ]);
  }

  const listaVia = [...via.values()].sort((a, b) => a.foroMm - b.foroMm);
  const listaPiste = [...piste.values()].sort((a, b) => a.larghezzaMm - b.larghezzaMm);

  /*
   * Il nome scritto a mano vince. Le VIA, quando non ce l'hanno, si chiamano
   * per taglia e non per ruolo: quasi tutte sono cuciture di massa, quindi il
   * ruolo le chiamerebbe tutte allo stesso modo, mentre chi disegna dice "la
   * piccola" e "la grande". Le PISTE invece il ruolo ce l'hanno vero, ed e'
   * quello che si vuole leggere: sei mil di segnale, venti di potenza.
   */
  const taglie =
    listaVia.length <= 1
      ? ["unica"]
      : listaVia.length === 2
        ? ["piccola", "grande"]
        : listaVia.length === 3
          ? ["piccola", "media", "grande"]
          : listaVia.map((c) => inMil(c.foroMm));
  listaVia.forEach((c, i) => {
    const suo = (nomi.via ?? []).find(
      (n) => stessaMisura(n.padMm, c.padMm) && stessaMisura(n.foroMm, c.foroMm),
    );
    c.nome = suo?.nome?.trim() || taglie[i] || inMil(c.foroMm);
  });

  const ruoliPiste = listaPiste.map((c) => ruoloDelle(retiPista.get(String(c.larghezzaMm)) ?? []));
  listaPiste.forEach((c, i) => {
    const suo = (nomi.piste ?? []).find((n) => stessaMisura(n.larghezzaMm, c.larghezzaMm));
    const doppio = ruoliPiste.filter((r) => r === ruoliPiste[i]).length > 1;
    c.nome =
      suo?.nome?.trim() || (doppio ? `${ruoliPiste[i]} ${inMil(c.larghezzaMm)}` : ruoliPiste[i]);
  });

  return { via: listaVia, piste: listaPiste };
}

/** i nomi da salvare, agganciati alla misura che la famiglia ha adesso */
export function nomiDaSalvare(classi: ClassiRame): NomiDelleClassi {
  return {
    via: classi.via.map((c) => ({ padMm: c.padMm, foroMm: c.foroMm, nome: c.nome })),
    piste: classi.piste.map((c) => ({ larghezzaMm: c.larghezzaMm, nome: c.nome })),
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
