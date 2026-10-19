import { withLibrary } from "@/lib/agent-tools";
import { requireProjectAccess } from "@/lib/acl";
import type { CompileSummary } from "@/lib/compile";
import { extractComponents, extractIssues } from "@/lib/inspect";
import { filesHash, getCompileCache, getProject } from "@/lib/project-store";
import { SCHEMATIC_RULES, untrustedDataSection } from "@/lib/system-prompt";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * "Completa con Claude": a project briefing to paste into an external agent.
 * Context, constraints and the state of the board; no recipe (LLM-first
 * rule): the external model plans the work itself.
 *
 * It COMPUTES NOTHING: the state is the last cached compile, like
 * claude-command. Before, every GET ran a full compile (minutes of CPU), and
 * a link-shared project let anyone without an account trigger it at will.
 *
 * Everything that comes from the project (names, messages, descriptions,
 * code) is inside a fenced, nonce-marked data section: the agent this text is
 * pasted into usually holds the user's token.
 */
export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  // also validates projectId: it is printed outside the data section
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const files = await getProject(projectId);
  const cache = await getCompileCache(projectId).catch(() => null);
  const summary = (cache?.summary ?? null) as CompileSummary | null;
  const circuitJson = cache?.circuitJson ?? null;
  const upToDate = cache
    ? cache.filesHash === filesHash(await withLibrary(files).catch(() => files))
    : false;

  const manual = summary?.manualEdits;
  const lines: string[] = [
    `# Progetto PCB \`${projectId}\` (PCB Studio / tscircuit)`,
    "",
    "Sto progettando una scheda elettronica con PCB Studio: ti passo lo stato attuale perche' tu la migliori.",
    "",
    "## Come funziona",
    "- Il progetto E' il codice tscircuit nei dati qui sotto: React che compila in schematico, PCB e file di produzione.",
    "- Posizioni in millimetri con pcbX/pcbY, centro scheda = (0,0). Le tracce si dichiarano con <trace from=\".R1 > .pin1\" to=\"net.VCC\" />.",
    "- L'autorouter viene eseguito alla compilazione: se ci sono sovrapposizioni di componenti viene SALTATO e ogni connessione risulta mancante.",
    "- Lo stato nei dati viene dall'ultima compilazione salvata, non da una compilazione fatta adesso.",
    "",
    "## Obiettivo",
    "Una scheda che compila senza errori, con tutte le connessioni instradate, senza violazioni delle regole di produzione e con uno schematico leggibile.",
    "",
    // Without these rules an external agent rewrites main.tsx from scratch and
    // reintroduces schX/schY, which disables the schematic automatic layout.
    "## Vincoli",
    "- Le regole di fabbricazione del progetto non si allentano per far sparire le violazioni.",
    // The external agent only receives the code: without this line it would
    // touch the coordinates of components the user placed on purpose, and the
    // result would be invisible because manual edits win.
    ...(manual && manual.total > 0
      ? [
          `- L'utente ha fissato a mano ${manual.schematic} simboli sullo schematico, ${manual.pcb} componenti sul rame e ${manual.traceHints} piste. Quelle posizioni vivono fuori dal codice e vincono su qualsiasi pcbX/pcbY scritto: si cambia il circuito, non il piazzamento di quei componenti.`,
        ]
      : []),
    "- Consegna: il file main.tsx COMPLETO (niente diff), con una breve spiegazione delle scelte, da incollare nella chat di PCB Studio o da scrivere via MCP se sei collegato.",
    "",
    "### Regole per lo schematico (vincolanti)",
    SCHEMATIC_RULES.split("\n").slice(1).join("\n"),
    "",
  ];

  const data: string[] = [];
  if (summary && circuitJson) {
    const issues = extractIssues(circuitJson);
    const components = extractComponents(circuitJson, files);
    const unrouted = summary.unroutedConnections ?? [];
    const drc = summary.drcViolations ?? [];
    data.push(
      "stato dell'ultima compilazione:",
      `- allineata ai sorgenti attuali: ${upToDate ? "si'" : "no (i file sono cambiati dopo)"}`,
      `- esito: ${summary.message}`,
      `- componenti: ${components.length}`,
      `- connessioni non instradate: ${unrouted.length}`,
      `- violazioni delle regole di produzione (DRC): ${drc.length}`,
    );
    if (summary.errors?.length) {
      data.push("", "errori:");
      for (const e of summary.errors.slice(0, 20)) data.push(`- ${e.message}`);
    }
    if (unrouted.length) {
      data.push("", "connessioni non instradate:");
      for (const u of unrouted.slice(0, 30)) data.push(`- ${u}`);
    }
    if (drc.length) {
      data.push("", "DRC:");
      for (const v of drc.slice(0, 15)) data.push(`- ${v.message}`);
    }
    const sq = summary.schematicQuality;
    if (sq) {
      data.push(
        "",
        "schematico:",
        `- simboli: ${sq.symbols}, coppie sovrapposte: ${sq.symbolOverlapCount}, incroci: ${sq.traceCrossings}`,
        `- sezioni funzionali: ${sq.sections.length ? sq.sections.join(", ") : "nessuna"}` +
          `${sq.sectionsWithFrames.length ? ` | con cornice: ${sq.sectionsWithFrames.join(", ")}` : ""}`,
      );
      for (const i of sq.issues.slice(0, 8)) data.push(`- [${i.severity}] ${i.message}`);
    }
    if (issues.length) {
      data.push("", "altri avvisi:");
      for (const i of issues.slice(0, 10)) {
        data.push(`- ${i.message}${i.x !== null ? ` (x=${i.x}, y=${i.y})` : ""}`);
      }
    }
    data.push("", "posizione attuale dei componenti:");
    for (const c of components.slice(0, 60)) {
      data.push(
        `- ${c.name}${c.value ? ` (${c.value})` : ""}: x=${c.x}, y=${c.y}` +
          `${c.footprint ? `, ${c.footprint}` : ""}${c.nets.length ? `, reti: ${c.nets.join("/")}` : ""}`,
      );
    }
  } else {
    data.push("stato: nessuna compilazione salvata per questo progetto.");
  }

  data.push("", "codice del progetto:");
  for (const [path, content] of Object.entries(files)) {
    const fence = codeFence(content);
    data.push("", `file ${path}:`, `${fence}tsx`, content, fence);
  }

  lines.push(untrustedDataSection(data.join("\n")));

  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** a backtick fence longer than any run of backticks inside the code */
function codeFence(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((m) => m.length));
  return "`".repeat(Math.max(3, longest + 1));
}
