import { withLibrary } from "@/lib/agent-tools";
import { requireProjectAccess } from "@/lib/acl";
import { compileProject } from "@/lib/compile";
import { extractComponents, extractIssues } from "@/lib/inspect";
import { getProject } from "@/lib/project-store";
import { SCHEMATIC_RULES } from "@/lib/system-prompt";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * "Completa con Claude": prepares a complete project briefing to paste into
 * an external agent. It contains everything needed to work without access to
 * the system: instructions, compile status, issues, and code.
 */
export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const files = await getProject(projectId);
  const { summary, circuitJson } = await compileProject(await withLibrary(files));
  const issues = extractIssues(circuitJson);
  const components = extractComponents(circuitJson, files);

  const unrouted = summary.unroutedConnections ?? [];
  const drc = summary.drcViolations ?? [];

  const lines: string[] = [
    `# Progetto PCB "${projectId}" (PCB Studio / tscircuit)`,
    "",
    "Sto progettando una scheda elettronica. Ti passo lo stato e ti chiedo di migliorarlo.",
    "",
    "## Come funziona",
    "- Il progetto E' il codice tscircuit qui sotto: React che compila in schematico, PCB e file di produzione.",
    "- Posizioni in millimetri con pcbX/pcbY, centro scheda = (0,0). Le tracce si dichiarano con <trace from=\".R1 > .pin1\" to=\"net.VCC\" />.",
    "- L'autorouter viene eseguito alla compilazione: se ci sono sovrapposizioni di componenti viene SALTATO e ogni connessione risulta mancante.",
    "- Rispondimi con il file main.tsx COMPLETO e corretto (niente diff), spiegando in breve le scelte di piazzamento.",
    "",
    // Without these rules an external agent rewrites main.tsx from scratch and
    // reintroduces schX/schY, which disables the schematic automatic layout.
    "## Regole per lo schematico (vincolanti)",
    SCHEMATIC_RULES.split("\n").slice(1).join("\n"),
    "",
    // The external agent only receives main.tsx: without this line it would
    // touch the coordinates of components the user placed on purpose, and the
    // result would be invisible because manual edits win.
    ...(summary.manualEdits.total > 0
      ? [
          "## Componenti fissati a mano dall'utente",
          `L'utente ha fissato ${summary.manualEdits.schematic} simboli sullo schematico, ${summary.manualEdits.pcb} componenti sul rame e instradato ${summary.manualEdits.traceHints} piste a mano. Quelle posizioni vivono fuori da main.tsx e vincono su qualsiasi pcbX/pcbY tu scriva: cambia il circuito, non il piazzamento di quei componenti.`,
          "",
        ]
      : []),
    "## Stato dell'ultima compilazione",
    `- esito: ${summary.message}`,
    `- componenti: ${components.length}`,
    `- connessioni non instradate: ${unrouted.length}`,
    `- violazioni delle regole di produzione (DRC): ${drc.length}`,
  ];

  if (summary.errors?.length) {
    lines.push("", "### Errori");
    for (const e of summary.errors.slice(0, 20)) lines.push(`- ${e.message}`);
  }
  if (unrouted.length) {
    lines.push("", "### Connessioni non instradate");
    for (const u of unrouted.slice(0, 30)) lines.push(`- ${u}`);
  }
  if (drc.length) {
    lines.push("", "### DRC");
    for (const v of drc.slice(0, 15)) lines.push(`- ${v.message}`);
  }
  const sq = summary.schematicQuality;
  lines.push(
    "",
    "### Schematico",
    `- simboli: ${sq.symbols}, coppie sovrapposte: ${sq.symbolOverlapCount}, incroci: ${sq.traceCrossings}`,
    `- sezioni funzionali: ${sq.sections.length ? sq.sections.join(", ") : "NESSUNA (da sezionare)"}` +
      `${sq.sectionsWithFrames.length ? ` | con cornice: ${sq.sectionsWithFrames.join(", ")}` : ""}`,
  );
  for (const i of sq.issues.slice(0, 8)) lines.push(`- [${i.severity}] ${i.message}`);
  if (issues.length) {
    lines.push("", "### Altri avvisi");
    for (const i of issues.slice(0, 10)) {
      lines.push(`- ${i.message}${i.x !== null ? ` (x=${i.x}, y=${i.y})` : ""}`);
    }
  }

  lines.push("", "## Posizione attuale dei componenti");
  for (const c of components.slice(0, 60)) {
    lines.push(
      `- ${c.name}${c.value ? ` (${c.value})` : ""}: x=${c.x}, y=${c.y}` +
        `${c.footprint ? `, ${c.footprint}` : ""}${c.nets.length ? `, reti: ${c.nets.join("/")}` : ""}`,
    );
  }

  lines.push("", "## Codice del progetto");
  for (const [path, content] of Object.entries(files)) {
    lines.push("", `### ${path}`, "```tsx", content, "```");
  }

  lines.push(
    "",
    "## Cosa ti chiedo",
    "Migliora il piazzamento perché l'autorouter chiuda tutte le connessioni: allontana i componenti che si sovrappongono, avvicina quelli collegati fra loro, tieni il rame a distanza dal bordo. Mantieni 4 layer con i piani di massa e alimentazione, e le piste di potenza a 0.5mm.",
    "",
    "Quando hai finito, incolla il main.tsx completo nella chat di PCB Studio (o scrivilo via MCP se sei collegato).",
  );

  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
