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
  /** le via che sono rimaste com'erano perche' non c'era posto, e perche' */
  viaLasciate?: number;
  motivi?: Record<string, number>;
}

interface Ostacoli {
  pads: Array<{ poly: Array<{ x: number; y: number }>; net: string; foroMm: number }>;
  vie: Array<{ x: number; y: number; rMm: number; foroMm: number; net: string }>;
  tratti: Array<{
    a: { x: number; y: number };
    b: { x: number; y: number };
    semiMm: number;
    net: string;
  }>;
}

/**
 * ALLARGARE UN FORO IN MEZZO A UN RAME GIA' INSTRADATO NON E' GRATIS.
 *
 * Portare la via piccola alla misura standard e' la cosa giusta dove c'e'
 * spazio — un foro da sei mil su una scheda da 1.4mm e' un rapporto di 9 a 1,
 * lavoro fine pagato anche dove non serve — ma sotto il BGA lo spazio non c'e',
 * e una via allargata contro la pista del vicino e' un corto che nessuno ha
 * chiesto.
 *
 * Quindi si allarga DOVE CI STA, una via alla volta, misurando contro il rame
 * delle altre reti con le distanze del progetto (comprese quelle per coppia:
 * su questa scheda un pad puo' stare a un mil da una via) e contro i fori con
 * la distanza foro-foro. Quelle che non ci stanno restano come sono e vengono
 * contate: su BAT_BS 479 su 510 passano, 31 no, e quelle 31 sono esattamente
 * il fanout stretto.
 */
function distanzaPuntoPoligono(
  px: number,
  py: number,
  poly: Array<{ x: number; y: number }>,
): number {
  let dentro = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      dentro = !dentro;
    }
  }
  if (dentro) return 0;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)));
  }
  return best;
}

/** se una via di quella misura, in quel punto, sta dentro le regole */
function ciSta(
  x: number,
  y: number,
  net: string,
  padMm: number,
  foroMm: number,
  o: Ostacoli,
  d: { padVia: number; viaVia: number; pistaVia: number; foroForo: number },
): string | null {
  const r = padMm / 2;
  for (const p of o.pads) {
    if (p.net && net && p.net === net) continue;
    if (distanzaPuntoPoligono(x, y, p.poly) - r < d.padVia - 0.001) return "pad di un'altra rete";
    if (p.foroMm > 0 && Math.hypot(p.poly[0].x - x, p.poly[0].y - y) < 5) {
      const centro = p.poly.reduce((s, q) => ({ x: s.x + q.x / p.poly.length, y: s.y + q.y / p.poly.length }), { x: 0, y: 0 });
      if (Math.hypot(centro.x - x, centro.y - y) - (p.foroMm + foroMm) / 2 < d.foroForo - 0.001) {
        return "foro contro foro";
      }
    }
  }
  for (const v of o.vie) {
    const dist = Math.hypot(v.x - x, v.y - y);
    if (dist < 1e-6) continue; // e' lei stessa
    if (v.net !== net && dist - v.rMm - r < d.viaVia - 0.001) return "via di un'altra rete";
    if (dist - (v.foroMm + foroMm) / 2 < d.foroForo - 0.001) return "foro contro foro";
  }
  for (const t of o.tratti) {
    if (t.net && net && t.net === net) continue;
    const dx = t.b.x - t.a.x;
    const dy = t.b.y - t.a.y;
    const l2 = dx * dx + dy * dy;
    const u = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - t.a.x) * dx + (y - t.a.y) * dy) / l2));
    const dist = Math.hypot(x - (t.a.x + u * dx), y - (t.a.y + u * dy));
    if (dist - t.semiMm - r < d.pistaVia - 0.001) return "pista di un'altra rete";
  }
  return null;
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

/**
 * Lo stesso cambio, ma allargando solo dove ci sta: vedi ciSta.
 * Restringere sta sempre, quindi la misura si applica e basta.
 */
export function applicaDoveCiSta(
  routes: ManualRoute[],
  cambi: { via?: CambioVia[]; piste?: CambioPista[] },
  ostacoli: Ostacoli,
  distanze: { padVia: number; viaVia: number; pistaVia: number; foroForo: number },
): EsitoCambio {
  /*
   * CRESCONO TUTTE INSIEME, e il vicino cresce anche lui.
   *
   * Misurare una via alla volta contro il rame com'e' adesso e' sbagliato di un
   * fattore due: due via della stessa famiglia a un decimo l'una dall'altra
   * passano il controllo tutte e due e poi si trovano addosso, perche' ognuna e'
   * stata misurata contro il vicino piccolo. Su BAT_BS e' successo una volta,
   * due via finite a 0.142 dove il minimo e' 0.1524.
   *
   * Quindi il vicino della stessa famiglia si misura GIA' CRESCIUTO: si perde
   * qualche via che forse ci sarebbe stata, e non se ne perde nessuna che non
   * ci sta.
   */
  const cresciuti: Ostacoli = {
    pads: ostacoli.pads,
    tratti: ostacoli.tratti,
    vie: ostacoli.vie.map((v) => {
      const c = (cambi.via ?? []).find(
        (x) => stessaMisura(x.da.padMm, v.rMm * 2) && stessaMisura(x.da.foroMm, v.foroMm),
      );
      return c ? { ...v, rMm: Math.max(v.rMm, c.a.padMm / 2), foroMm: Math.max(v.foroMm, c.a.foroMm) } : v;
    }),
  };
  let viaCambiate = 0;
  let pisteCambiate = 0;
  let viaLasciate = 0;
  const motivi: Record<string, number> = {};

  const fuori = routes.map((r) => {
    if (!eUnaVia(r)) {
      const c = (cambi.piste ?? []).find((x) => stessaMisura(x.daMm, r.width ?? 0));
      if (!c) return r;
      pisteCambiate++;
      return { ...r, width: r4(c.aMm) };
    }
    const pad = r.viaDiameter ?? 0;
    const foro = r.viaHoleDiameter ?? 0;
    const c = (cambi.via ?? []).find(
      (x) => stessaMisura(x.da.padMm, pad) && stessaMisura(x.da.foroMm, foro),
    );
    if (!c) return r;
    const allarga = c.a.padMm > pad + UGUALE_MM || c.a.foroMm > foro + UGUALE_MM;
    if (allarga) {
      const male = ciSta(
        r.points[0].x,
        r.points[0].y,
        String(r.net ?? ""),
        c.a.padMm,
        c.a.foroMm,
        cresciuti,
        distanze,
      );
      if (male) {
        viaLasciate++;
        motivi[male] = (motivi[male] ?? 0) + 1;
        return r;
      }
    }
    viaCambiate++;
    return { ...r, viaDiameter: r4(c.a.padMm), viaHoleDiameter: r4(c.a.foroMm) };
  });

  return { routes: fuori, viaCambiate, pisteCambiate, viaLasciate, motivi };
}

/** il rame contro cui si misura, letto dalla scheda compilata */
export function ostacoliDaCircuito(circuitJson: unknown[]): Ostacoli {
  const els = circuitJson as Array<Record<string, unknown>>;
  const netDiChiave = new Map<string, string>();
  for (const e of els) {
    if (e.type === "source_net" && e.subcircuit_connectivity_map_key) {
      netDiChiave.set(String(e.subcircuit_connectivity_map_key), String(e.name ?? ""));
    }
  }
  const gruppoDiPorta = new Map<string, string>();
  for (const e of els) {
    if (e.type !== "source_trace") continue;
    const k = String(e.subcircuit_connectivity_map_key ?? "");
    for (const p of (e.connected_source_port_ids as string[] | undefined) ?? []) {
      gruppoDiPorta.set(String(p), k);
    }
  }
  const sorgenteDiPorta = new Map<string, string>();
  for (const e of els) {
    if (e.type === "pcb_port") sorgenteDiPorta.set(String(e.pcb_port_id), String(e.source_port_id));
  }
  const retePad = (e: Record<string, unknown>) =>
    netDiChiave.get(gruppoDiPorta.get(sorgenteDiPorta.get(String(e.pcb_port_id ?? "")) ?? "") ?? "") ??
    "";

  const pads: Ostacoli["pads"] = [];
  const vie: Ostacoli["vie"] = [];
  const tratti: Ostacoli["tratti"] = [];
  for (const e of els) {
    if (e.type === "pcb_smtpad" || e.type === "pcb_plated_hole") {
      const x = Number(e.x);
      const y = Number(e.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const hw = Number(e.width ?? (Number(e.radius ?? 0) || Number(e.outer_diameter ?? 0)) ) / 2;
      const hh = Number(e.height ?? (Number(e.radius ?? 0) || Number(e.outer_diameter ?? 0))) / 2;
      const rad = ((Number(e.ccw_rotation ?? 0) || 0) * Math.PI) / 180;
      const co = Math.cos(rad);
      const si = Math.sin(rad);
      pads.push({
        net: retePad(e),
        foroMm: Number(e.hole_diameter ?? 0) || 0,
        poly: [
          [-hw, -hh],
          [hw, -hh],
          [hw, hh],
          [-hw, hh],
        ].map(([a, b]) => ({ x: x + a * co - b * si, y: y + a * si + b * co })),
      });
      continue;
    }
    if (e.type === "pcb_via") {
      vie.push({
        x: Number(e.x),
        y: Number(e.y),
        rMm: Number(e.outer_diameter ?? 0) / 2,
        foroMm: Number(e.hole_diameter ?? 0),
        net: netDiChiave.get(String(e.subcircuit_connectivity_map_key ?? "")) ?? "",
      });
      continue;
    }
    if (e.type !== "pcb_trace") continue;
    const st = els.find(
      (x) => x.type === "source_trace" && String(x.source_trace_id) === String(e.source_trace_id),
    );
    const net = netDiChiave.get(String(st?.subcircuit_connectivity_map_key ?? "")) ?? "";
    const rotta = (e.route as Array<Record<string, unknown>> | undefined) ?? [];
    for (let i = 1; i < rotta.length; i++) {
      const a = rotta[i - 1];
      const b = rotta[i];
      if (a.route_type !== "wire" || b.route_type !== "wire" || a.layer !== b.layer) continue;
      tratti.push({
        a: { x: Number(a.x), y: Number(a.y) },
        b: { x: Number(b.x), y: Number(b.y) },
        semiMm: Number(b.width ?? a.width ?? 0.15) / 2,
        net,
      });
    }
  }
  return { pads, vie, tratti };
}
