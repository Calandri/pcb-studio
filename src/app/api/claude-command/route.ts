import { requireProjectAccess } from "@/lib/acl";
import { extractComponents } from "@/lib/inspect";
import { getCompileCache, getProject } from "@/lib/project-store";

export const runtime = "nodejs";

/**
 * The command to paste into Claude.
 *
 * THIS ENDPOINT EXECUTES NOTHING. It produces text: a task, the context to
 * carry it out, and the constraints. There is no "if re-placing then call
 * this tool, then that one" branch: which tool to call and in which order is
 * decided by the model, which has them all (LLM-first rule). If tomorrow a better tool is added
 * to do the same thing, these commands will use it without being touched.
 *
 * The context is taken from the LAST cached compilation rather than by
 * recompiling: recompiling here would cost minutes before even handing the
 * command to the user, and the model will recompile anyway as soon as it
 * starts.
 */

type Kind = "place" | "route";
type Scope = "all" | "selection";

const mcpSetup = (origin: string) =>
  "Se non ce l'hai gia', collega PCB Studio come server MCP (cosi' lavora il modello che hai gia', niente chiavi API in piu'):\n" +
  "1. genera un token personale in PCB Studio: Team → Accesso da agenti esterni (MCP)\n" +
  `2. registra il server: \`claude mcp add --transport http pcb-studio ${origin}/api/mcp/mcp --header "Authorization: Bearer <il tuo token pcbs_...>"\`\n` +
  "(vale per Claude Code e per qualsiasi client MCP: l'URL e' lo stesso, l'header anche)";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "default";
  const kind: Kind = url.searchParams.get("kind") === "route" ? "route" : "place";
  const scope: Scope = url.searchParams.get("scope") === "selection" ? "selection" : "all";
  const picked = (url.searchParams.get("components") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 80);
  const zone = parseZone(url.searchParams.get("zone"));

  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const cache = await getCompileCache(projectId).catch(() => null);
  const summary = (cache?.summary ?? null) as Record<string, unknown> | null;
  const files = await getProject(projectId);
  const components = cache ? extractComponents(cache.circuitJson, files) : [];
  const byName = new Map(components.map((c) => [c.name, c]));

  const lines: string[] = [
    `# ${title(kind, scope)} sul progetto PCB "${projectId}"`,
    "",
    mcpSetup(url.origin),
    "",
    `Lavora sul progetto \`${projectId}\` con gli strumenti di PCB Studio. Il progetto E' il codice tscircuit: leggilo con read_project, riscrivi i file interi con write_file, e verifica sempre con compile.`,
    "",
  ];

  // --- the starting state, so the model does not start from scratch
  if (summary) {
    lines.push(
      "## Da dove parti",
      `- ultima compilazione: ${str(summary.message) || "senza messaggio"}`,
      `- piste instradate: ${num(summary.pcbTraces) ?? "?"}`,
      `- connessioni ancora aperte: ${arr(summary.unroutedConnections).length}`,
      `- violazioni DRC: ${arr(summary.drcViolations).length}`,
    );
    const drc = arr(summary.drcViolations);
    if (drc.length) {
      lines.push("", "### Le violazioni da chiudere");
      for (const v of drc.slice(0, 12)) lines.push(`- ${str((v as Record<string, unknown>).message)}`);
      const hot = hotspots(drc);
      if (hot.length) {
        lines.push(
          "",
          "Le violazioni non sono sparse: si concentrano in queste zone da 5mm (x, y del vertice in basso a sinistra, in mm, centro scheda = 0,0).",
        );
        for (const h of hot) {
          lines.push(`- zona ${h.x}..${h.x + 5} , ${h.y}..${h.y + 5}: ${h.n} violazioni`);
        }
      }
    }
    const unrouted = arr(summary.unroutedConnections);
    if (unrouted.length) {
      lines.push("", "### Connessioni non instradate");
      for (const u of unrouted.slice(0, 25)) lines.push(`- ${str(u)}`);
    }
    lines.push("");
  } else {
    lines.push(
      "## Da dove parti",
      "Non c'e' una compilazione in cache: la prima cosa da fare e' `compile`, per vedere lo stato.",
      "",
    );
  }

  // --- the perimeter: everything, or only what the user has selected
  if (scope === "selection" && kind === "place" && picked.length) {
    lines.push(
      "## Perimetro: SOLO questi componenti",
      "L'utente ha selezionato questi componenti nel visualizzatore. Sposta SOLO questi. Ogni altro componente deve restare esattamente dove sta: se cambi un pcbX o un pcbY che non e' in questo elenco, hai sbagliato il lavoro.",
      "",
    );
    for (const name of picked) {
      const c = byName.get(name);
      lines.push(
        c
          ? `- ${c.name}${c.value ? ` (${c.value})` : ""}${c.tags ? ` [${c.tags}]` : ""}: ora a x=${c.x}, y=${c.y}` +
            `${c.footprint ? `, ${c.footprint}` : ""}${c.nets.length ? `, reti: ${c.nets.join("/")}` : ""}` +
            `${c.description ? `\n    ${c.description}` : ""}`
          : `- ${name}`,
      );
    }
    lines.push("");
    const box = boundsOf(picked, byName);
    if (box) {
      lines.push(
        `Occupano oggi il rettangolo da ${box.minX},${box.minY} a ${box.maxX},${box.maxY} (mm). Dopo averli spostati e ricompilato, se il rame di quell'area resta brutto puoi rifarlo da solo con \`reroute_zone\` su quel rettangolo allargato di un paio di millimetri, invece di ricompilare tutto.`,
        "",
      );
    }
  }

  if (scope === "selection" && kind === "route" && zone) {
    lines.push(
      "## Perimetro: SOLO questa zona di rame",
      `L'utente ha selezionato il rettangolo da ${zone.minX},${zone.minY} a ${zone.maxX},${zone.maxY} (mm, centro scheda = 0,0).`,
      "",
      `Usa \`reroute_zone\` con esattamente queste coordinate: strappa e rifa' SOLO le piste li' dentro, il resto della scheda non si tocca. Attenzione: vengono strappate solo le piste interamente contenute nel rettangolo, quindi se non succede niente allarga la zona.`,
      "",
      "Se `reroute_zone` risponde che non ha migliorato, non insistere con lo stesso rettangolo: il router e' deterministico e ridara' la stessa geometria. In quel caso il problema e' la densita', non il percorso: allontana i componenti di quell'area con write_file e ricompila.",
      "",
    );
  }

  // --- the actual task
  lines.push("## Cosa ti chiedo", ...task(kind, scope), "");

  lines.push(
    "## Come lavorare",
    "- Non fermarti al primo `compile`: guarda il risultato, correggi, ricompila. Hai finito quando gli errori sono zero e le violazioni DRC non scendono piu'.",
    "- Ogni chiamata che fai compare in diretta nella pagina che l'utente ha aperta, e la scheda si aggiorna mentre lavori: puoi lavorare a lungo, ti sta guardando.",
    "- Quando hai finito dimmi in due righe cosa hai cambiato e come sono cambiati i numeri (piste, connessioni aperte, violazioni DRC), non riassumermi il codice.",
  );

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

function task(kind: Kind, scope: Scope): string[] {
  if (kind === "place") {
    return [
      scope === "all"
        ? "Ridisponi il piazzamento dei componenti sulla scheda."
        : "Ridisponi i componenti elencati sopra, e solo quelli.",
      "",
      "I criteri, in ordine di importanza:",
      "1. Zero sovrapposizioni. Due componenti che si toccano fanno saltare del tutto l'autorouter, e la scheda risulta senza piste senza che sia colpa dello sbroglio.",
      "2. Vicini quelli collegati fra loro. Una pista lunga il doppio della scheda vuol dire che il pezzo sta dalla parte sbagliata.",
      "3. Aria dove il rame e' fitto. Le zone con piu' violazioni DRC sono zone dove non ci sta quello che deve passarci: allargale.",
      "4. I condensatori di disaccoppiamento restano attaccati al piedino di alimentazione che servono, non spostarli via.",
      "5. I connettori restano sul bordo, con il verso di innesto verso l'esterno.",
      "",
      "Muovi i componenti cambiando pcbX/pcbY nel codice con write_file, poi compile. Il piazzamento si giudica dai numeri della compilazione, non a occhio.",
    ];
  }
  return [
    scope === "all"
      ? "Rifa' lo sbroglio della scheda e portalo in regola."
      : "Rifa' il rame della zona selezionata e portalo in regola.",
    "",
    "L'obiettivo e' in quest'ordine: zero connessioni aperte, poi zero violazioni DRC, poi meno via e meno rame.",
    "",
    "Cosa funziona davvero, in ordine di resa:",
    "1. `reroute_zone` sulle zone calde: costa secondi invece di minuti e non rimescola il rame che gia' va bene.",
    "2. Allontanare i componenti dove le violazioni si concentrano. Se una zona rifatta non migliora, il problema e' la densita': li' non ci sta il rame che deve passarci, e nessun percorso lo risolve.",
    "3. `compile` sull'intera scheda solo quando hai cambiato il piazzamento.",
    "",
    "Non abbassare le regole di fabbricazione per far sparire le violazioni: una scheda che passa il controllo perche' hai allentato il controllo non si produce lo stesso.",
  ];
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
 * say where to intervene; "the first three cells contain two thirds of them"
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
