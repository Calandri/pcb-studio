import { requireProjectAccess } from "@/lib/acl";
import { salvaControllo } from "@/lib/component-checks";
import { cercaErrata, scaricaErrata } from "@/lib/errata";
import { getAgentKeys } from "@/lib/llm-keys";
import { listUserOrganizations } from "@/lib/org-store";
import { runAgentTurn } from "@/lib/llm";
import { getCompileCache } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * THE ERRATA OF ONE PART, found, read and judged against THIS board.
 *
 * Three steps, and the order is the point: the document is FOUND first (see
 * errata.ts: never an invented address), then downloaded and kept, and only
 * then read. The model never answers from memory — it is given the text of the
 * errata sheet and the pins of the part as it is wired here, and asked which of
 * those defects can touch this circuit.
 *
 * When a part has no published errata that is a result too, and it gets
 * recorded: "looked for it here, the manufacturer publishes none". Next time
 * nobody looks again, which is the whole reason the board exists.
 */

const SYSTEM = `Sei un progettista elettronico che legge un documento di errata del produttore e dice
cosa cambia PER QUESTA scheda.

REGOLE, non negoziabili:
- parla SOLO di errata che stanno nel testo che ti viene dato. Se un difetto non e' nel documento,
  non esiste: non aggiungerlo a memoria.
- cita ogni difetto col suo numero e titolo come li scrive il produttore.
- per ognuno che tocca questa scheda dì PERCHE' la tocca, guardando come il componente e' collegato.
- se nessuno dei difetti tocca questa scheda, dillo chiaramente: e' una risposta buona quanto le altre.
- scrivi in italiano, asciutto, senza preamboli.`;

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const projectId = typeof body.projectId === "string" ? body.projectId : "default";
  const componente = String(body.componente ?? "").trim();
  const { ok, viewer } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  if (!componente) return Response.json({ error: "componente mancante" }, { status: 400 });

  const cache = await getCompileCache(projectId);
  const elementi = (cache?.circuitJson ?? []) as Array<Record<string, unknown>>;
  const parte = elementi.find(
    (e) => e.type === "source_component" && String(e.name ?? "") === componente,
  );
  if (!parte) return Response.json({ error: "componente non trovato" }, { status: 404 });
  const mpn = String(parte.manufacturer_part_number ?? "").trim();
  if (!mpn) {
    return Response.json(
      { error: `${componente} non ha un codice produttore: non c'e' niente da cercare` },
      { status: 400 },
    );
  }

  const ricerca = await cercaErrata({
    projectId,
    mpn,
    produttore: typeof body.produttore === "string" ? body.produttore : null,
  });

  if (!ricerca.trovato) {
    /*
     * No document is an answer, and it is recorded as one: the next person does
     * not repeat the search, and the note says where it was looked.
     */
    await salvaControllo({
      projectId,
      componente,
      voce: "errata",
      stato: "non-applicabile",
      nota: `${ricerca.nota} (${mpn})`,
      fonte: ricerca.cercatoIn.join(" | "),
      chi: viewer?.email ?? "pcb-studio",
    });
    return Response.json({ trovato: false, nota: ricerca.nota, cercatoIn: ricerca.cercatoIn });
  }

  const documento = await scaricaErrata({ projectId, mpn, documento: ricerca.trovato });

  /** how the part is wired here: without it the analysis is about the chip, not the board */
  const porte = elementi
    .filter((e) => e.type === "source_port" && e.source_component_id === parte.source_component_id)
    .map((e) => String(e.name ?? e.pin_number ?? "?"));
  const reti = new Map<string, string>();
  for (const e of elementi) {
    if (e.type !== "source_net") continue;
    reti.set(String(e.source_net_id), String(e.name ?? ""));
  }
  const collegamenti: string[] = [];
  for (const e of elementi) {
    if (e.type !== "source_trace") continue;
    const porteTracciate = (e.connected_source_port_ids as string[] | undefined) ?? [];
    const mie = porteTracciate.filter((p) =>
      elementi.some(
        (x) =>
          x.type === "source_port" &&
          String(x.source_port_id) === p &&
          x.source_component_id === parte.source_component_id,
      ),
    );
    if (mie.length === 0) continue;
    const net = ((e.connected_source_net_ids as string[] | undefined) ?? [])
      .map((n) => reti.get(String(n)))
      .filter(Boolean)[0];
    if (net) collegamenti.push(`${componente}.${mie.length} -> ${net}`);
  }

  const brief = [
    `Componente: ${componente} (${mpn}), ${porte.length} piedini.`,
    collegamenti.length
      ? `Come e' collegato su questa scheda:\n${collegamenti.slice(0, 40).join("\n")}`
      : "Nessuna connessione dichiarata.",
    `\nDocumento di errata ${ricerca.trovato.codice ?? ""} (${ricerca.trovato.url}), ${documento.pagine} pagine:\n\n${documento.testo.slice(0, 90_000)}`,
  ].join("\n\n");

  const risposta = await runAgentTurn(
    {
      system: SYSTEM,
      tools: [
        {
          name: "salva_analisi",
          description: "Salva l'analisi degli errata per questo componente.",
          input_schema: {
            type: "object",
            properties: {
              riassunto: {
                type: "string",
                description: "una riga: quanti errata, e quanti toccano questa scheda",
              },
              rilevanti: {
                type: "string",
                description:
                  "i difetti che toccano questa scheda, col loro numero e titolo, e perche' la toccano. Vuoto se nessuno.",
              },
            },
            required: ["riassunto", "rilevanti"],
          },
        },
      ],
      messages: [{ role: "user", content: brief }],
    },
    {
      keys: viewer
        ? await getAgentKeys(
            viewer.userId,
            (await listUserOrganizations(viewer.userId).catch(() => [])).map((o) => o.id),
          ).catch(() => ({}))
        : {},
    },
  );

  const call = risposta.content.find((b) => b.type === "tool_use" && b.name === "salva_analisi");
  if (!call || call.type !== "tool_use") {
    return Response.json({ error: "il modello non ha prodotto un'analisi" }, { status: 502 });
  }
  const input = (call.input ?? {}) as { riassunto?: unknown; rilevanti?: unknown };
  const riassunto = String(input.riassunto ?? "").trim().slice(0, 400);
  const rilevanti = String(input.rilevanti ?? "").trim().slice(0, 3000);

  await salvaControllo({
    projectId,
    componente,
    voce: "errata",
    stato: "fatto",
    nota: [riassunto, rilevanti].filter(Boolean).join("\n\n").slice(0, 600),
    fonte: `${ricerca.trovato.codice ?? "errata"} — ${ricerca.trovato.url}`,
    chi: viewer?.email ?? "pcb-studio",
  });

  return Response.json({
    trovato: true,
    documento: ricerca.trovato,
    pagine: documento.pagine,
    riassunto,
    rilevanti,
  });
}
