import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * POST /api/manual-edits {action: "pasted_vias"}: le vie che la persona ha
 * incollato nel visore, tolte o spostate da un agente col token personale di
 * chi possiede il progetto (Niccolo', 2026-11-19: sei vie sotto l'O-ring dei
 * microfoni da togliere, undici da allineare, e col token si potevano solo
 * liberare pezzi). Solo vie incollate, tutto o niente, spostamenti coi
 * controlli di un trascinamento, scritto nel log chi e cosa.
 *
 * I file sono lo store vero, in memoria; la scheda salvata e' compilata davvero.
 */
const stato = vi.hoisted(() => ({
  sessione: false,
  utente: { userId: "u-niccolo", email: "niccolo@example.com" } as null | { userId: string; email: string },
  accesso: "edit" as "none" | "view" | "edit",
  proprietario: true,
  riga: null as null | { filesHash: string; circuitJson: unknown[]; summary: unknown; createdAt: string; engineVersion: number; base: null },
}));

vi.mock("@/lib/acl", () => ({
  requireProjectAccess: async () => ({ ok: stato.sessione, viewer: null }),
  accessoDaRichiesta: async () => false,
  currentViewer: async () => (stato.sessione ? stato.utente : null),
  projectAccess: async () => stato.accesso,
  canManageProject: async () => stato.proprietario,
}));
vi.mock("@/lib/api-tokens", () => ({ resolveApiToken: async (t: string) => (t === "pcbs_buono" ? stato.utente : null) }));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    projectExists: async () => true,
    getCompileCache: vi.fn(async () => stato.riga),
    getCompileMeta: vi.fn(async () => (stato.riga ? { filesHash: stato.riga.filesHash, createdAt: stato.riga.createdAt, engineVersion: 13, base: null } : null)),
  };
});

import { POST } from "@/app/api/manual-edits/route";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { emptyManualEdits, MANUAL_EDITS_PATH, parseManualEdits, serializeManualEdits } from "@/lib/manual-edits";
import type { ManualViaMove } from "@/lib/manual-routes";
import { filesHash, getProject, writeProjectFile } from "@/lib/project-store";
import { leggiRichiestaVieIncollate, MAX_VIE_INCOLLATE } from "@/lib/vie-incollate";

const REGOLE = JSON.stringify({ preset: "custom", rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false } });
const MAIN = `export default () => (
  <board width="40mm" height="24mm">
    <net name="GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-10} pcbY={0} />
    <net name="SIG" />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R1 > .pin2" to="net.SIG" />
    <via name="V1" pcbX={0} pcbY={-6} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
  </board>
)
`;
const FILES: Record<string, string> = { "main.tsx": MAIN, [DESIGN_RULES_PATH]: REGOLE };
const incollata = (x: number, y: number): ManualViaMove => ({ net: "GND", from: { x, y }, to: { x, y }, holeDiameter: 0.2, outerDiameter: 0.3, layers: ["top", "bottom"], aggiunta: true });
/** una via dei file spostata: una correzione, non una via incollata */
const DEI_FILE: ManualViaMove = { net: "GND", from: { x: 0, y: -6 }, to: { x: 0, y: -5 }, holeDiameter: 0.2, outerDiameter: 0.3, layers: ["top", "bottom"] };

let compilata: Awaited<ReturnType<typeof compileProject>>;
beforeAll(async () => {
  compilata = await compileProject(FILES);
}, 120_000);

let n = 0;
let P = "";
beforeEach(async () => {
  Object.assign(stato, { sessione: false, utente: { userId: "u-niccolo", email: "niccolo@example.com" }, accesso: "edit", proprietario: true });
  P = `prova-vie-incollate-${++n}`;
  for (const [path, testo] of Object.entries(FILES)) await writeProjectFile(P, path, testo);
  await writeProjectFile(P, MANUAL_EDITS_PATH, serializeManualEdits({ ...emptyManualEdits(), pcb_vias: [incollata(6, -9), incollata(8, -9), DEI_FILE] }));
  stato.riga = { filesHash: filesHash(await getProject(P)), circuitJson: compilata.circuitJson as unknown[], summary: {}, createdAt: "2026-11-19T10:00:00.000Z", engineVersion: 13, base: null };
});

const chiama = (body: Record<string, unknown>, token: string | null = "pcbs_buono") =>
  POST(
    new Request("http://x/api/manual-edits", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ projectId: P, action: "pasted_vias", ...body }),
    }),
  );
const vie = async () => parseManualEdits((await getProject(P))[MANUAL_EDITS_PATH]).pcb_vias.map((v) => [v.to.x, v.to.y, v.aggiunta === true]);

describe("le vie incollate col token di chi possiede il progetto", () => {
  it("toglie le vie incollate nominate, e solo quelle: la via dei file spostata resta", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await chiama({ unpaste: [{ net: "GND", x: 6, y: -9 }] });
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { removed: ManualViaMove[] };
    expect(corpo.removed.map((v) => [v.to.x, v.to.y])).toEqual([[6, -9]]);
    expect(await vie()).toEqual([[8, -9, true], [0, -5, false]]);
    // nel log: chi, cosa, prima e dopo
    expect(log.mock.calls.flat().join(" ")).toMatch(/vie incollate da niccolo@example\.com \(token\): tolte 1 \[GND\(6,-9\)\], spostate 0/);
    log.mockRestore();
  });

  it("sposta una via incollata col salvataggio di un trascinamento: resta incollata, col posto dove era stata incollata", async () => {
    const r = await chiama({ movePastedVias: [{ net: "GND", from: { x: 8, y: -9 }, to: { x: 8, y: -8.6 } }] });
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { moved: Array<{ prima: ManualViaMove; dopo: ManualViaMove }> };
    expect(corpo.moved[0].dopo.to).toEqual({ x: 8, y: -8.6 });
    const file = parseManualEdits((await getProject(P))[MANUAL_EDITS_PATH]).pcb_vias;
    const spostata = file.find((v) => v.to.x === 8 && v.to.y === -8.6)!;
    expect(spostata.aggiunta).toBe(true);
    expect(spostata.from).toEqual({ x: 8, y: -9 });
    expect(await vie()).toEqual(expect.arrayContaining([[6, -9, true], [0, -5, false], [8, -8.6, true]]));
    expect(file).toHaveLength(3);
  });

  it("tutto o niente: una via che non c'e', una via dei file, un posto fuori dalla scheda o una distanza violata non scrivono nulla", async () => {
    const prima = await vie();
    // la via dei file spostata non e' incollata
    expect((await chiama({ unpaste: [{ net: "GND", x: 6, y: -9 }, { net: "GND", x: 0, y: -5 }] })).status).toBe(404);
    expect((await chiama({ unpaste: [{ net: "PWR", x: 6, y: -9 }] })).status).toBe(404);
    // fuori dalla scheda (40 x 24)
    expect((await chiama({ movePastedVias: [{ net: "GND", from: { x: 8, y: -9 }, to: { x: 30, y: -9 } }] })).status).toBe(400);
    // sopra il piedino 2 di R1 (rete SIG): la distanza
    const sopra = await chiama({ unpaste: [{ net: "GND", x: 6, y: -9 }], movePastedVias: [{ net: "GND", from: { x: 8, y: -9 }, to: { x: -9.49, y: 0 } }] });
    expect(sopra.status).toBe(409);
    expect(await vie()).toEqual(prima);
  });

  it("solo chi possiede il progetto, col token valido, e il permesso di modifica", async () => {
    const prima = await vie();
    stato.proprietario = false;
    expect((await chiama({ unpaste: [{ net: "GND", x: 6, y: -9 }] })).status).toBe(403);
    stato.proprietario = true;
    expect((await chiama({ unpaste: [{ net: "GND", x: 6, y: -9 }] }, "pcbs_falso")).status).toBe(403);
    stato.accesso = "view";
    expect((await chiama({ unpaste: [{ net: "GND", x: 6, y: -9 }] })).status).toBe(403);
    // senza token e senza sessione
    stato.accesso = "edit";
    expect((await chiama({ unpaste: [{ net: "GND", x: 6, y: -9 }] }, null)).status).toBe(403);
    expect(await vie()).toEqual(prima);
    // la sessione del browser con il permesso di modifica puo', anche senza essere proprietaria
    Object.assign(stato, { sessione: true, proprietario: false });
    expect((await chiama({ unpaste: [{ net: "GND", x: 6, y: -9 }] }, null)).status).toBe(200);
  });

  it("col token anche l'unpaste di una via del visore passa da qui; il resto col token resta chiuso", async () => {
    const r = await POST(
      new Request("http://x/api/manual-edits", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer pcbs_buono" },
        body: JSON.stringify({ projectId: P, action: "unpaste", via: { net: "GND", x: 8, y: -9 } }),
      }),
    );
    expect(r.status).toBe(200);
    expect(await vie()).toEqual([[6, -9, true], [0, -5, false]]);
    for (const body of [
      { action: "copper", gesto: "g", vias: [{ ...DEI_FILE, from: { x: 0, y: -6 }, to: { x: 0, y: -4 } }] },
      { action: "set", edits: emptyManualEdits() },
      { action: "place", placements: [{ name: "R1", x: 1, y: 1 }] },
      { action: "release", scope: "all", name: null },
    ]) {
      const q = await POST(new Request("http://x/api/manual-edits", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer pcbs_buono" }, body: JSON.stringify({ projectId: P, ...body }) }));
      expect(q.status, JSON.stringify(body)).toBe(403);
    }
    expect(await vie()).toEqual([[6, -9, true], [0, -5, false]]);
  });
});

describe("la richiesta, letta", () => {
  it("rifiuta coordinate non finite o non numeri, reti che non sono nomi, doppi, liste vuote o troppo lunghe", () => {
    expect(leggiRichiestaVieIncollate({})).toMatch(/nessuna via/);
    expect(leggiRichiestaVieIncollate({ unpaste: [{ net: "GND", x: "6", y: -9 }] })).toMatch(/due numeri/);
    expect(leggiRichiestaVieIncollate({ unpaste: [{ net: "GND", x: Number.NaN, y: -9 }] })).toMatch(/due numeri/);
    expect(leggiRichiestaVieIncollate({ unpaste: [{ net: "GND; DROP", x: 6, y: -9 }] })).toMatch(/nome/);
    expect(leggiRichiestaVieIncollate({ movePastedVias: [{ net: "GND", from: { x: 1, y: 1 }, to: { x: 1, y: 1 } }] })).toMatch(/stesso posto/);
    expect(leggiRichiestaVieIncollate({ unpaste: [{ net: "GND", x: 1, y: 1 }], movePastedVias: [{ net: "GND", from: { x: 1, y: 1 }, to: { x: 2, y: 1 } }] })).toMatch(/due volte/);
    expect(leggiRichiestaVieIncollate({ unpaste: Array.from({ length: MAX_VIE_INCOLLATE + 1 }, (_, i) => ({ net: "GND", x: i, y: 0 })) })).toMatch(/troppe/);
    expect(leggiRichiestaVieIncollate({ unpaste: [{ net: "GND", x: 1e9, y: 0 }] })).toMatch(/due numeri/);
    expect(leggiRichiestaVieIncollate({ unpaste: [{ net: "GND", x: 1.23456, y: 0 }] })).toEqual({ togli: [{ net: "GND", x: 1.2346, y: 0 }], sposta: [] });
  });
});
