import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { executeTool, withLibrary } from "@/lib/agent-tools";
import { resolveApiToken } from "@/lib/api-tokens";
import { compileProject } from "@/lib/compile";
import { extractComponents, extractIssues } from "@/lib/inspect";
import { listAccessibleProjects, projectAccess, type Viewer } from "@/lib/acl";
import { getProject } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * Server MCP di PCB Studio: espone gli STESSI strumenti che usa l'agente
 * interno, cosi' un agente esterno (Claude Code, un connettore, uno script)
 * puo' progettare schede con il proprio modello.
 *
 * Non si espone il Circuit JSON come superficie di scrittura: la verita' e' il
 * codice tscircuit, e ogni modifica passa da write_file + compile come per
 * l'agente interno.
 *
 * Autenticazione: token personale Bearer (pcbs_...). Ogni chiamata verifica
 * l'accesso al progetto con la stessa ACL dell'app: nessuna scorciatoia.
 */

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "token mancante o non valido" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="pcb-studio"',
    },
  });
}

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

function buildHandler(viewer: Viewer) {
  return createMcpHandler(
    (server) => {
    server.tool(
      "list_projects",
      "Elenca i progetti PCB accessibili a questo utente.",
      {},
      async () => text({ projects: await listAccessibleProjects(viewer) }),
    );

    server.tool(
      "read_project",
      "Legge i file tscircuit di un progetto (il codice E' il progetto).",
      { projectId: z.string() },
      async ({ projectId }) => {
        if ((await projectAccess(projectId, viewer)) === "none") {
          return text({ error: "nessun accesso a questo progetto" });
        }
        return text({ files: await getProject(projectId) });
      },
    );

    server.tool(
      "write_file",
      "Scrive un file del progetto con il contenuto COMPLETO (niente diff). " +
        "Poi chiama compile per validare: e' la compilazione a dire se il progetto sta in piedi.",
      { projectId: z.string(), path: z.string(), content: z.string() },
      async ({ projectId, path, content }) => {
        if ((await projectAccess(projectId, viewer)) !== "edit") {
          return text({ error: "serve accesso in modifica a questo progetto" });
        }
        const { result } = await executeTool(projectId, "write_file", { path, content });
        return text(result);
      },
    );

    server.tool(
      "compile",
      "Compila il progetto: instrada il PCB, esegue il DRC e restituisce errori, " +
        "connessioni non instradate, congestione e geometria. E' lo strumento centrale.",
      { projectId: z.string() },
      async ({ projectId }) => {
        if ((await projectAccess(projectId, viewer)) === "none") {
          return text({ error: "nessun accesso a questo progetto" });
        }
        const { summary } = await compileProject(await withLibrary(await getProject(projectId)));
        return text(summary);
      },
    );

    server.tool(
      "inspect_board",
      "Fotografia della scheda compilata: problemi con posizione e componenti con " +
        "coordinate e reti collegate. Utile per decidere dove spostare i pezzi.",
      { projectId: z.string() },
      async ({ projectId }) => {
        if ((await projectAccess(projectId, viewer)) === "none") {
          return text({ error: "nessun accesso a questo progetto" });
        }
        const { circuitJson } = await compileProject(
          await withLibrary(await getProject(projectId)),
        );
        return text({
          issues: extractIssues(circuitJson).slice(0, 60),
          components: extractComponents(circuitJson),
        });
      },
    );

    server.tool(
      "search_parts",
      "Cerca componenti reali disponibili a magazzino su JLCPCB.",
      { query: z.string(), package: z.string().optional(), limit: z.number().optional() },
      async (args) => {
        const { result } = await executeTool("-", "search_parts", args);
        return text(result);
      },
    );

    server.tool(
      "import_component_from_lcsc",
      "Scarica footprint e simbolo REALI di un componente LCSC e lo salva in libreria. " +
        "Da preferire sempre a disegnare un footprint a mano.",
      { lcsc: z.string() },
      async ({ lcsc }) => {
        const { result } = await executeTool("-", "import_component_from_lcsc", { lcsc });
        return text(result);
      },
    );

    server.tool(
      "library_list",
      "Elenca i componenti riusabili in libreria (montati in ogni progetto come lib/<Nome>.tsx).",
      {},
      async () => {
        const { result } = await executeTool("-", "library_list", {});
        return text(result);
      },
    );

    server.tool(
      "export_urls",
      "Restituisce i link per scaricare i file di produzione del progetto.",
      { projectId: z.string() },
      async ({ projectId }) => {
        if ((await projectAccess(projectId, viewer)) === "none") {
          return text({ error: "nessun accesso a questo progetto" });
        }
        const base = process.env.AUTH_URL ?? "https://pcb-studio-3bee.vercel.app";
        return text({
          gerber: `${base}/api/export?projectId=${projectId}&kind=gerber`,
          bom: `${base}/api/export?projectId=${projectId}&kind=bom`,
          pickAndPlace: `${base}/api/export?projectId=${projectId}&kind=pnp`,
          nota: "i link richiedono la sessione dell'app nel browser",
        });
      },
      );
    },
    {},
    // il route sta in app/api/mcp/[transport]: senza basePath il gestore
    // cercherebbe gli endpoint alla radice e risponderebbe "Not found"
    { basePath: "/api/mcp", maxDuration: 800, verboseLogs: false },
  );
}

async function handle(req: Request): Promise<Response> {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const identity = bearer ? await resolveApiToken(bearer) : null;
  if (!identity) return unauthorized();
  return buildHandler(identity)(req);
}

export { handle as GET, handle as POST, handle as DELETE };
