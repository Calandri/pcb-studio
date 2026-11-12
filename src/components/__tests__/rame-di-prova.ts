import { emptyManualEdits, type ManualEdits } from "@/lib/manual-edits";
import { manualRouteKey, type ManualRoute } from "@/lib/manual-routes";
import type {
  BersaglioDelRame,
  SalvataggioDelGesto,
  StatoDelGesto,
} from "@/lib/spinta/gesto-tipi";

/*
 * The board, the targets, the gesture and the server the tests of the copper
 * gesture of "Sposta" share. The solver is never the real one there
 * (`@/lib/spinta/gesto` is mocked): these are the answers the mock gives.
 *
 * The board: a part on top (C1) and one under (R2), away from the copper; a
 * trace on top that ends on a via (tr_top, via_a), one on the bottom that ends
 * on another (tr_bot, via_b), a hand route on an inner plane (tr_in1). Every
 * width is different, so something drawn is recognised by its number.
 */

const filo = (x: number, y: number, layer: string, width: number) => ({ route_type: "wire", x, y, layer, width });

/** the hand route of the inner plane as manual-edits.json holds it */
export const PISTA_A_MANO: ManualRoute = {
  connection: ".C1 > .pin1 to .R2 > .pin2",
  from: ".C1 > .pin1",
  to: ".R2 > .pin2",
  width: 0.313,
  points: [
    { x: 0, y: 0, layer: "inner1" },
    { x: 0, y: 5, layer: "inner1" },
  ],
};

/** what the gesture of the tests asks to be saved: the via moved to (-3; 6), its trace after it, the hand route shortened */
export const SALVATAGGIO: SalvataggioDelGesto = {
  routes: [
    {
      connection: ".C1 > .pin1 to .R2 > .pin1",
      width: 0.311,
      points: [
        { x: -5, y: 0, layer: "top" },
        { x: -3, y: 6, layer: "top" },
      ],
      replaces: {
        original: [
          { x: -5, y: 0, layer: "top" },
          { x: -5, y: 5, layer: "top" },
        ],
        width: 0.311,
      },
    },
  ],
  vias: [
    {
      net: "GND",
      from: { x: -5, y: 5 },
      to: { x: -3, y: 6 },
      holeDiameter: 0.31,
      outerDiameter: 0.61,
      layers: ["top", "inner1", "inner2", "bottom"],
    },
  ],
  riscritte: [
    {
      chiave: manualRouteKey(PISTA_A_MANO),
      points: [
        { x: 0, y: 0, layer: "inner1" },
        { x: 0, y: 4, layer: "inner1" },
      ],
    },
  ],
};

/** the saved board for a manual-edits.json: what the fast update lays, as far as these tests look */
export function schedaDa(file: ManualEdits): unknown[] {
  const via = file.pcb_vias.find((v) => v.from.x === -5 && v.from.y === 5)?.to ?? { x: -5, y: 5 };
  const corretta = file.pcb_routes.find((r) => r.replaces)?.points;
  const aMano = file.pcb_routes.find((r) => !r.replaces)?.points ?? PISTA_A_MANO.points;
  const pista = (id: string, punti: Array<{ x: number; y: number; layer: string }>, width: number) => ({
    type: "pcb_trace",
    pcb_trace_id: id,
    route: punti.map((p) => filo(p.x, p.y, p.layer, width)),
  });
  return [
    { type: "pcb_board", width: 30, height: 20, center: { x: 0, y: 0 }, num_layers: 4 },
    { type: "source_component", source_component_id: "s1", name: "C1" },
    { type: "source_component", source_component_id: "s2", name: "R2" },
    { type: "pcb_component", pcb_component_id: "pc_top", source_component_id: "s1", center: { x: -10, y: -6 }, width: 2, height: 1, rotation: 0, layer: "top" },
    { type: "pcb_component", pcb_component_id: "pc_bot", source_component_id: "s2", center: { x: 10, y: -6 }, width: 2, height: 1, rotation: 0, layer: "bottom" },
    { type: "pcb_smtpad", pcb_smtpad_id: "pad_top", pcb_component_id: "pc_top", shape: "rect", x: -10, y: -6, width: 1.11, height: 0.61, layer: "top" },
    { type: "pcb_smtpad", pcb_smtpad_id: "pad_bot", pcb_component_id: "pc_bot", shape: "rect", x: 10, y: -6, width: 1.22, height: 0.62, layer: "bottom" },
    pista("tr_top", corretta ?? [{ x: -5, y: 0, layer: "top" }, { x: -5, y: 5, layer: "top" }], 0.311),
    pista("tr_bot", [{ x: 5, y: 0, layer: "bottom" }, { x: 5, y: 5, layer: "bottom" }], 0.312),
    pista("tr_in1", aMano, 0.313),
    { type: "pcb_via", pcb_via_id: "via_a", x: via.x, y: via.y, outer_diameter: 0.61, hole_diameter: 0.31 },
    { type: "pcb_via", pcb_via_id: "via_b", x: 5, y: 5, outer_diameter: 0.62, hole_diameter: 0.32 },
  ];
}

/** the file the tests start from: the hand route of the inner plane and nothing else */
export const fileDiPartenza = (): ManualEdits => ({ ...emptyManualEdits(), pcb_routes: [PISTA_A_MANO] });

/** the board the tests start from */
export const SCHEDA = schedaDa(fileDiPartenza());

/** what the mocked preseDelRame answers for the board: two vias, a stretch on each of three layers */
export const BERSAGLI: BersaglioDelRame[] = [
  { tipo: "tratto", pcbTraceId: "tr_top", indice: 0, x1: -5, y1: 0, x2: -5, y2: 5, layer: "top", width: 0.311 },
  { tipo: "via", pcbViaId: "via_a", x: -5, y: 5, outerDiameter: 0.61 },
  { tipo: "tratto", pcbTraceId: "tr_bot", indice: 0, x1: 5, y1: 0, x2: 5, y2: 5, layer: "bottom", width: 0.312 },
  { tipo: "via", pcbViaId: "via_b", x: 5, y: 5, outerDiameter: 0.62 },
  { tipo: "tratto", pcbTraceId: "tr_in1", indice: 0, x1: 0, y1: 0, x2: 0, y2: 5, layer: "inner1", width: 0.313 },
];

/** the copper via_a carries, the same object for every state of the gesture as the solver does */
export const NASCOSTI: StatoDelGesto["nascosti"] = { pcbTraceIds: ["tr_top"], pcbViaIds: ["via_a"] };

/** the state the mocked solver gives with via_a at (x; y): its trace follows it, nothing blocks */
export const statoConLaViaIn = (x: number, y: number, extra: Partial<StatoDelGesto> = {}): StatoDelGesto => ({
  nascosti: NASCOSTI,
  tratti: [{ x1: -5, y1: 0, x2: x, y2: y, layer: "top", width: 0.311 }],
  vie: [{ x, y, outerDiameter: 0.61, holeDiameter: 0.31 }],
  posizione: { x, y },
  blocco: null,
  mosso: x !== -5 || y !== 5,
  ...extra,
});

type Richiesta = { metodo: string; url: string; corpo: Record<string, unknown> | null };

/**
 * /api/manual-edits as far as the copper gesture goes: the file read, the
 * action `copper` (the corrections enter the file, a hand route is rewritten
 * in its place) and the action `set` (the state of an undo). `rifiuta` makes
 * the next `copper` answer 409 with that sentence. Every request is kept.
 */
export function serverFinto() {
  const stato = {
    file: fileDiPartenza(),
    richieste: [] as Richiesta[],
    rifiuta: null as string | null,
  };
  const risposta = (status: number, corpo: unknown) => ({ ok: status < 400, status, json: async () => corpo });
  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const metodo = init?.method ?? "GET";
    const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    stato.richieste.push({ metodo, url, corpo });
    if (!url.startsWith("/api/manual-edits")) return risposta(404, { error: "non c'e'" });
    if (metodo === "GET") return risposta(200, { ok: true, edits: stato.file });
    if (corpo?.action === "copper") {
      if (stato.rifiuta) {
        const reason = stato.rifiuta;
        stato.rifiuta = null;
        return risposta(409, { error: `rame non salvato: ${reason}`, reason });
      }
      const { routes, vias, riscritte } = corpo as unknown as SalvataggioDelGesto;
      stato.file = {
        ...stato.file,
        pcb_routes: [
          ...stato.file.pcb_routes.map((r) => {
            const nuova = riscritte.find((x) => x.chiave === manualRouteKey(r));
            return nuova ? { ...r, points: nuova.points } : r;
          }),
          ...routes,
        ],
        pcb_vias: [...stato.file.pcb_vias, ...vias],
      };
      return risposta(200, { ok: true, routes, vias, replaced: { routes: [], vias: [] } });
    }
    if (corpo?.action === "set") {
      stato.file = corpo.edits as ManualEdits;
      return risposta(200, { ok: true, edits: stato.file });
    }
    return risposta(400, { error: "azione sconosciuta" });
  };
  return {
    stato,
    fetch,
    /** the writes asked so far, without the reads of the file */
    scritture: () => stato.richieste.filter((r) => r.metodo === "POST"),
  };
}
