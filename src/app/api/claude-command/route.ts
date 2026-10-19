import { withLibrary } from "@/lib/agent-tools";
import { requireProjectAccess } from "@/lib/acl";
import { extractComponents } from "@/lib/inspect";
import { filesHash, getCompileCache, getProject } from "@/lib/project-store";
import { untrustedDataSection } from "@/lib/system-prompt";

export const runtime = "nodejs";

/**
 * The command to paste into Claude.
 *
 * THIS ENDPOINT EXECUTES NOTHING. It produces text: the goal the user picked,
 * the constraints, and the state of the board as DATA. There is no recipe in
 * it ("first call this tool, then that one"): which tool to call and in which
 * order is decided by the model, which has them all (LLM-first rule). If
 * tomorrow a better tool is added, these commands will use it without being
 * touched.
 *
 * Everything that comes from the project (names, values, DRC messages,
 * descriptions) goes inside a fenced, nonce-marked data section: the external
 * agent holds the user's token, and project text must never read to it as
 * part of the request.
 *
 * The state is taken from the LAST cached compilation rather than by
 * recompiling: recompiling here would cost minutes before even handing the
 * command to the user, and the model will recompile anyway.
 */

type Kind = "place" | "route";
type Scope = "all" | "selection";

const mcpSetup = (origin: string) =>
  "Se non ce l'hai gia', collega PCB Studio come server MCP (cosi' lavora il modello che hai gia', niente chiavi API in piu'):\n" +
  "- il token personale si genera in PCB Studio: Team → Accesso da agenti esterni (MCP)\n" +
  `- il server si registra con \`claude mcp add --transport http pcb-studio ${origin}/api/mcp/mcp --header "Authorization: Bearer <il tuo token pcbs_...>"\`\n` +
  "(vale per Claude Code e per qualsiasi client MCP: l'URL e' lo stesso, l'header anche)";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "default";
  const kind: Kind = url.searchParams.get("kind") === "route" ? "route" : "place";
  const scope: Scope = url.searchParams.get("scope") === "selection" ? "selection" : "all";
  const picked = (url.searchParams.get("components") ?? "")
    .split(",")
    .map((s) => s.trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 80);
  const zone = parseZone(url.searchParams.get("zone"));

  // also validates projectId: it is printed outside the data section
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const cache = await getCompileCache(projectId).catch(() => null);
  const summary = (cache?.summary ?? null) as Record<string, unknown> | null;
  const files = await getProject(projectId);
  const components = cache ? extractComponents(cache.circuitJson, files) : [];
  const byName = new Map(components.map((c) => [c.name, c]));
  const upToDate = cache
    ? cache.filesHash === filesHash(await withLibrary(files).catch(() => files))
    : false;

  const selectionPlace = scope === "selection" && kind === "place" && picked.length > 0;
  const selectionRoute = scope === "selection" && kind === "route" && zone !== null;

  const lines: string[] = [
    `# ${title(kind, scope)} sul progetto PCB \`${projectId}\``,
    "",
    mcpSetup(url.origin),
    "",
    "## Contesto",
    `- Il progetto \`${projectId}\` e' codice tscircuit: con gli strumenti di PCB Studio si legge (read_project), si riscrive a file interi (write_file) e si verifica (compile, che restituisce errori, connessioni aperte e violazioni).`,
    "- Ogni chiamata compare in diretta nella pagina che l'utente ha aperto, e la scheda si aggiorna mentre lavori.",
    "- Lo stato qui sotto viene dall'ultima compilazione salvata, non da una compilazione fatta adesso.",
    "",
    "## Obiettivo",
    goal(kind, scope, selectionPlace, selectionRoute),
    "",
    "## Vincoli",
    ...constraints(kind, selectionPlace, selectionRoute, zone),
    "",
  ];

  // --- the state, as data
  const data: string[] = [];
  if (summary) {
    data.push(
      "stato:",
      `- compilazione allineata ai sorgenti attuali: ${upToDate ? "si'" : "no (i file sono cambiati dopo)"}`,
      `- ultima compilazione: ${str(summary.message) || "senza messaggio"}`,
      `- piste instradate: ${num(summary.pcbTraces) ?? "?"}`,
      `- connessioni ancora aperte: ${arr(summary.unroutedConnections).length}`,
      `- violazioni DRC: ${arr(summary.drcViolations).length}`,
    );
    const drc = arr(summary.drcViolations);
    if (drc.length) {
      data.push("", "violazioni DRC (le prime 12):");
      for (const v of drc.slice(0, 12)) data.push(`- ${str((v as Record<string, unknown>).message)}`);
      const hot = hotspots(drc);
      if (hot.length) {
        data.push(
          "",
          "celle da 5mm con piu' violazioni (x, y del vertice in basso a sinistra, mm, centro scheda = 0,0):",
        );
        for (const h of hot) data.push(`- ${h.x}..${h.x + 5} , ${h.y}..${h.y + 5}: ${h.n} violazioni`);
      }
    }
    const unrouted = arr(summary.unroutedConnections);
    if (unrouted.length) {
      data.push("", "connessioni non instradate (le prime 25):");
      for (const u of unrouted.slice(0, 25)) data.push(`- ${str(u)}`);
    }
  } else {
    data.push("stato: nessuna compilazione salvata per questo progetto.");
  }

  if (selectionPlace) {
    data.push("", "componenti selezionati dall'utente nel visualizzatore:");
    for (const name of picked) {
      const c = byName.get(name);
      data.push(
        c
          ? `- ${c.name}${c.value ? ` (${c.value})` : ""}${c.tags ? ` [${c.tags}]` : ""}: ora a x=${c.x}, y=${c.y}` +
              `${c.footprint ? `, ${c.footprint}` : ""}${c.nets.length ? `, reti: ${c.nets.join("/")}` : ""}` +
              `${c.description ? `\n    descrizione: ${c.description}` : ""}`
          : `- ${name} (non trovato nella compilazione salvata)`,
      );
    }
    const box = boundsOf(picked, byName);
    if (box) {
      data.push("", `rettangolo occupato oggi dai selezionati (mm): da ${box.minX},${box.minY} a ${box.maxX},${box.maxY}`);
    }
  }

  lines.push(untrustedDataSection(data.join("\n")));

  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function title(kind: Kind, scope: Scope): string {
  if (kind === "place") {
    return scope === "all" ? "Ridisponi tutti i componenti" : "Ridisponi i componenti selezionati";
  }
  return scope === "all" ? "Re-instrada tutta la scheda" : "Re-instrada la zona selezionata";
}

function goal(kind: Kind, scope: Scope, selectionPlace: boolean, selectionRoute: boolean): string {
  if (kind === "place") {
    return selectionPlace
      ? "Un piazzamento migliore dei componenti selezionati (elencati nei dati), con il resto della scheda com'e'."
      : "Un piazzamento migliore dei componenti della scheda.";
  }
  return selectionRoute
    ? "Il rame della zona selezionata in regola, con il resto della scheda com'e'."
    : scope === "all"
      ? "Lo sbroglio della scheda in regola."
      : "Lo sbroglio in regola.";
}

/** constraints and acceptance criteria, as statements: the plan is the model's */
function constraints(
  kind: Kind,
  selectionPlace: boolean,
  selectionRoute: boolean,
  zone: { minX: number; minY: number; maxX: number; maxY: number } | null,
): string[] {
  const out: string[] = [];
  if (selectionPlace) {
    out.push(
      "- Possono cambiare posizione SOLO i componenti selezionati. Ogni altro pcbX/pcbY resta esattamente com'e'.",
    );
  }
  if (selectionRoute && zone) {
    out.push(
      `- Il rame si rifa' SOLO dentro il rettangolo da ${zone.minX},${zone.minY} a ${zone.maxX},${zone.maxY} (mm, centro scheda = 0,0); fuori non si tocca.`,
    );
  }
  if (kind === "place") {
    out.push(
      "- Criteri di un buon piazzamento: nessuna sovrapposizione fra componenti (una sovrapposizione fa saltare l'autorouter); componenti collegati fra loro vicini; spazio dove le violazioni si addensano; condensatori di disaccoppiamento accanto al piedino di alimentazione che servono; connettori sul bordo, con l'innesto verso l'esterno.",
      "- Il piazzamento si giudica dai numeri della compilazione.",
    );
  } else {
    out.push(
      "- Priorita' dello sbroglio: zero connessioni aperte, poi zero violazioni DRC, poi meno via e meno rame.",
    );
  }
  out.push(
    "- Le regole di fabbricazione del progetto non si allentano per far sparire le violazioni: una scheda che passa il controllo perche' il controllo e' stato allentato non si produce lo stesso.",
    "- Risposta finale: in due righe cosa e' cambiato e come sono cambiati i numeri (piste, connessioni aperte, violazioni DRC), senza riassumere il codice.",
  );
  return out;
}

function parseZone(
  raw: string | null,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!raw) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [a, b, c, d] = parts;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    minX: r3(Math.min(a, c)),
    minY: r3(Math.min(b, d)),
    maxX: r3(Math.max(a, c)),
    maxY: r3(Math.max(b, d)),
  };
}

function boundsOf(
  names: string[],
  byName: Map<string, { x: number | null; y: number | null }>,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const n of names) {
    const c = byName.get(n);
    if (typeof c?.x === "number" && typeof c?.y === "number") {
      xs.push(c.x);
      ys.push(c.y);
    }
  }
  if (!xs.length) return null;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    minX: r1(Math.min(...xs)),
    minY: r1(Math.min(...ys)),
    maxX: r1(Math.max(...xs)),
    maxY: r1(Math.max(...ys)),
  };
}

/**
 * The 5mm cells with the most violations. A list of sixty reports does not
 * say where they are; "the first three cells contain two thirds of them"
 * does.
 */
function hotspots(violations: unknown[]): Array<{ x: number; y: number; n: number }> {
  const cells = new Map<string, number>();
  for (const v of violations) {
    const points = (v as { points?: Array<{ x?: unknown; y?: unknown }> }).points ?? [];
    for (const p of points) {
      if (typeof p.x !== "number" || typeof p.y !== "number") continue;
      const key = `${Math.floor(p.x / 5) * 5},${Math.floor(p.y / 5) * 5}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
  }
  return [...cells]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, n]) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y, n };
    });
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
