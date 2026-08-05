/**
 * LE LUNGHEZZE APPAIATE: il primo controllo che guarda se la scheda FUNZIONA
 * invece di se si riesce a fabbricare.
 *
 * Un bus arriva in fase solo se i suoi fili sono lunghi uguale. Il segnale corre
 * a sei centimetri per nanosecondo nel rame, quindi un millimetro di differenza
 * e' una ventina di picosecondi: su una PSRAM a cento megahertz non conta, sul
 * fronte di una SD a cinquanta conta, e su una DDR conta moltissimo. Chi disegna
 * lo sa e lo compensa a mano con le serpentine — su questa scheda ce ne sono, le
 * abbiamo importate — e Altium lo mette per iscritto: sette regole
 * `MatchedLengths` con tolleranza 47.2441 mil, cioe' 1.2mm, su cinque classi di
 * rete.
 *
 * Noi quelle regole le leggiamo dal file e le misuriamo sul rame che c'e'. Non e'
 * una cosa che l'occhio vede: due piste possono sembrare uguali e differire di
 * cinque millimetri.
 *
 * DUE ATTENZIONI, e sono la ragione per cui questo file esiste invece di essere
 * tre righe dentro prc.ts:
 *
 * 1. UN SEGNALE CHE ATTRAVERSA UN NET TIE, nel nostro modello, sono DUE reti. Su
 *    BIRDY il gruppo MIC_DATA contiene NetMIC1_1_3 e NetNT1_1, che sono i due
 *    pezzi dello stesso filo: misurarli separati e confrontarli fra loro non
 *    vuol dire niente. I ponti li conosciamo (li marchiamo all'import), quindi i
 *    pezzi si ricuciono prima di misurare.
 *
 * 2. LA LUNGHEZZA E' QUELLA DEL RAME, non del percorso fra due pin. Altium
 *    misura il tratto instradato fra i capi e ci aggiunge lo spessore delle via;
 *    noi sommiamo il rame della rete. Su una rete punto-punto sono la stessa
 *    cosa; su una con diramazioni la nostra e' piu' lunga, e va detto invece di
 *    far finta che siano la stessa misura.
 */

interface El {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export const LUNGHEZZE_PATH = "lunghezze-appaiate.json";

export interface GruppoLunghezza {
  /** il nome della classe di rete che il file appaia */
  nome: string;
  /** quanto possono differire, come lo dice il file */
  tolleranzaMm: number;
  /** i nomi delle reti, come li scrive il file */
  reti: string[];
}

export interface EsitoGruppo {
  gruppo: string;
  tolleranzaMm: number;
  scartoMm: number;
  dentro: boolean;
  misure: Array<{ net: string; lunghezzaMm: number; pezzi: number }>;
}

/** il file del progetto, che non deve fermare niente se e' rotto o assente */
export function leggiGruppi(raw: string | undefined | null): GruppoLunghezza[] {
  if (!raw) return [];
  try {
    const d = JSON.parse(raw) as { gruppi?: unknown };
    if (!Array.isArray(d?.gruppi)) return [];
    return d.gruppi
      .map((g) => g as Record<string, unknown>)
      .filter(
        (g) =>
          typeof g.nome === "string" &&
          Array.isArray(g.reti) &&
          (num(g.tolleranzaMm) ?? 0) > 0,
      )
      .map((g) => ({
        nome: String(g.nome),
        tolleranzaMm: num(g.tolleranzaMm)!,
        reti: (g.reti as unknown[]).map(String),
      }));
  } catch {
    return [];
  }
}

export function serializzaGruppi(gruppi: GruppoLunghezza[]): string {
  return `${JSON.stringify({ gruppi }, null, 2)}\n`;
}

/** union-find, per ricucire i pezzi di un segnale che passa da un net tie */
class Insieme {
  private padre = new Map<string, string>();
  radice(x: string): string {
    const p = this.padre.get(x);
    if (p === undefined) {
      this.padre.set(x, x);
      return x;
    }
    if (p === x) return x;
    const r = this.radice(p);
    this.padre.set(x, r);
    return r;
  }
  unisci(a: string, b: string): void {
    const ra = this.radice(a);
    const rb = this.radice(b);
    if (ra !== rb) this.padre.set(ra, rb);
  }
}

/**
 * La lunghezza del rame di ogni rete, coi pezzi dei net tie ricuciti insieme.
 * Il nome della rete e' quello che il file usa, perche' e' con quello che le
 * classi elencano i membri.
 */
function lunghezzePerRete(circuitJson: El[]): {
  lunghezza: Map<string, number>;
  pezzi: Map<string, number>;
  stessoSegnale: Insieme;
} {
  const nomeDiChiave = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "source_net") continue;
    const k = String(el.subcircuit_connectivity_map_key ?? "");
    if (k) nomeDiChiave.set(k, String(el.name ?? ""));
  }
  const netDiTraccia = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "source_trace") continue;
    const nome = nomeDiChiave.get(String(el.subcircuit_connectivity_map_key ?? ""));
    if (nome) netDiTraccia.set(String(el.source_trace_id ?? ""), nome);
  }
  /* la rete di ogni pad, per capire quali reti un ponte unisce */
  const gruppoDiPorta = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "source_trace") continue;
    const k = String(el.subcircuit_connectivity_map_key ?? "");
    for (const p of (el.connected_source_port_ids as string[] | undefined) ?? []) {
      gruppoDiPorta.set(String(p), k);
    }
  }
  const sorgenteDiPorta = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "pcb_port") {
      sorgenteDiPorta.set(String(el.pcb_port_id), String(el.source_port_id));
    }
  }
  const retePad = (el: El): string =>
    nomeDiChiave.get(
      gruppoDiPorta.get(sorgenteDiPorta.get(String(el.pcb_port_id ?? "")) ?? "") ?? "",
    ) ?? "";

  const lunghezza = new Map<string, number>();
  const pezzi = new Map<string, number>();
  const stessoSegnale = new Insieme();

  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const net = netDiTraccia.get(String(el.source_trace_id ?? "")) ?? "";
    if (!net) continue;
    const rotta = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    let L = 0;
    for (let i = 1; i < rotta.length; i++) {
      const a = rotta[i - 1];
      const b = rotta[i];
      if (a.route_type !== "wire" || b.route_type !== "wire" || a.layer !== b.layer) continue;
      const ax = num(a.x);
      const ay = num(a.y);
      const bx = num(b.x);
      const by = num(b.y);
      if (ax === null || ay === null || bx === null || by === null) continue;
      L += Math.hypot(bx - ax, by - ay);
    }
    if (L <= 0) continue;
    lunghezza.set(net, (lunghezza.get(net) ?? 0) + L);
    pezzi.set(net, (pezzi.get(net) ?? 0) + 1);
  }

  /*
   * I PONTI: le due reti che uniscono sono lo stesso filo.
   *
   * Il ponte finisce ESATTAMENTE sul centro dei due pad che unisce, quindi si
   * cerca il pad piu' vicino e si accetta solo se e' addosso. Con un raggio
   * generoso non funziona: i quattro net tie di questa scheda stanno in un
   * millimetro e mezzo, e cercando a tre decimi ogni capo trovava anche i pad
   * del ponte accanto — cucendo insieme le meta' sbagliate, cioe' il microfono
   * uno col microfono due.
   */
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace" || el.netTie !== true) continue;
    const reti: string[] = [];
    for (const p of (el.route as Array<Record<string, unknown>> | undefined) ?? []) {
      const x = num(p.x);
      const y = num(p.y);
      if (x === null || y === null) continue;
      let vicino: { d: number; net: string } | null = null;
      for (const pad of circuitJson) {
        if (pad.type !== "pcb_smtpad" && pad.type !== "pcb_plated_hole") continue;
        const px = num(pad.x);
        const py = num(pad.y);
        if (px === null || py === null) continue;
        const d = Math.hypot(px - x, py - y);
        if (d > 0.06) continue;
        const r = retePad(pad);
        if (r && (!vicino || d < vicino.d)) vicino = { d, net: r };
      }
      if (vicino && !reti.includes(vicino.net)) reti.push(vicino.net);
    }
    for (let i = 1; i < reti.length; i++) stessoSegnale.unisci(reti[0], reti[i]);
  }

  return { lunghezza, pezzi, stessoSegnale };
}

/**
 * Il conto, gruppo per gruppo: quanto sono lunghe le reti e quanto differiscono.
 * Un gruppo con meno di due reti che hanno rame non dice niente e resta fuori.
 */
export function controllaLunghezze(
  circuitJson: El[],
  gruppi: GruppoLunghezza[],
): EsitoGruppo[] {
  if (gruppi.length === 0) return [];
  const { lunghezza, pezzi, stessoSegnale } = lunghezzePerRete(circuitJson);
  const fuori: EsitoGruppo[] = [];

  for (const g of gruppi) {
    /* i pezzi dello stesso filo contano una volta: si sommano sotto un capo */
    const perSegnale = new Map<string, { net: string; L: number; pezzi: number }>();
    for (const net of g.reti) {
      const L = lunghezza.get(net);
      if (L === undefined) continue;
      const capo = stessoSegnale.radice(net);
      const prima = perSegnale.get(capo);
      perSegnale.set(capo, {
        net: prima ? `${prima.net}+${net}` : net,
        L: (prima?.L ?? 0) + L,
        pezzi: (prima?.pezzi ?? 0) + (pezzi.get(net) ?? 0),
      });
    }
    const misure = [...perSegnale.values()]
      .map((m) => ({ net: m.net, lunghezzaMm: Number(m.L.toFixed(2)), pezzi: m.pezzi }))
      .sort((a, b) => b.lunghezzaMm - a.lunghezzaMm);
    if (misure.length < 2) continue;
    const scarto = misure[0].lunghezzaMm - misure[misure.length - 1].lunghezzaMm;
    fuori.push({
      gruppo: g.nome,
      tolleranzaMm: g.tolleranzaMm,
      scartoMm: Number(scarto.toFixed(2)),
      dentro: scarto <= g.tolleranzaMm + 1e-9,
      misure,
    });
  }
  return fuori;
}
