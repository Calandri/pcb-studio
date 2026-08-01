import { runAgentTurn } from "./llm";
import type { AgentKeyMap } from "./llm-keys";

/**
 * The floorplan is decided by the model, not by a formula.
 *
 * Dividing a board into sections is a judgement call, not an optimisation: the
 * microphones go on the edge because they have to hear, the connector where the
 * cable arrives, the crystal glued to the microcontroller because its traces
 * must be short, the regulator far from the antenna. A geometric criterion
 * (column slicing) was tried and measured: 30% more copper and it did not
 * remove a single overlap, because it knows nothing about what the parts DO.
 *
 * So the model reads the blocks, the connections between blocks and the
 * constraints, and answers with a rectangle per section. Here we do not
 * negotiate: we verify. A plan that leaves a section outside the board, that
 * overlaps two sections or that gives a section less room than its parts occupy
 * is rejected with the reason, and the model gets one more go. What the solver
 * receives is a plan that holds up geometrically — then it is the solver's job
 * to place the parts inside it without overlaps.
 */

export interface SezioneRichiesta {
  /** section name: the same one the components' tags carry */
  nome: string;
  /** the parts that belong to it, to say how much room it needs */
  componenti: string[];
  /** area really occupied by its parts, in mm2 */
  areaMm2: number;
  /** how many wires it exchanges with each other section */
  legami: Record<string, number>;
  /** parts already pinned by hand: they cannot move, so they bind the section */
  fermi: Array<{ nome: string; x: number; y: number }>;
}

export interface Sezione {
  nome: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** why there: it goes back to the user, it is not decoration */
  perche: string;
}

export interface PianoSezioni {
  sezioni: Sezione[];
  /** the model's overall reasoning, one paragraph */
  ragionamento: string;
  /** which model answered */
  provider: string;
  /** how many attempts it took to get a plan that holds */
  tentativi: number;
}

const SCHEMA = {
  type: "object" as const,
  properties: {
    ragionamento: {
      type: "string" as const,
      description:
        "In italiano, in un paragrafo: come hai diviso la scheda e perche' quella divisione e' migliore delle alternative.",
    },
    sezioni: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          nome: { type: "string" as const },
          minX: { type: "number" as const },
          minY: { type: "number" as const },
          maxX: { type: "number" as const },
          maxY: { type: "number" as const },
          perche: {
            type: "string" as const,
            description: "In italiano, una frase: perche' questa sezione sta proprio qui.",
          },
        },
        required: ["nome", "minX", "minY", "maxX", "maxY", "perche"],
      },
    },
  },
  required: ["ragionamento", "sezioni"],
};

const SISTEMA = `Sei il progettista che decide la PIANTA di un circuito stampato: dove va ogni sezione logica sulla scheda.

Non instradi e non piazzi i singoli componenti: dividi la superficie in rettangoli, uno per sezione. Un risolutore numerico sistemera' i pezzi dentro il rettangolo che gli assegni.

Come si ragiona:
- I pezzi che si parlano molto vanno vicini: ogni filo lungo e' rame in piu', rumore in piu' e una pista che deve passare in mezzo alle altre.
- Chi deve stare sul bordo ci sta: connettori (il cavo arriva da fuori), microfoni e sensori (devono sentire), LED e pulsanti (si devono vedere e premere), antenne (il rame intorno le spegne).
- L'alimentazione va tenuta insieme e vicina a dove entra la corrente, ma lontana dai segnali delicati: un regolatore commuta e sporca.
- Il quarzo sta attaccato al microcontrollore, sempre: le sue due piste devono essere le piu' corte della scheda.
- I componenti gia' fissati a mano non si spostano: la loro posizione VINCOLA la sezione a cui appartengono, il rettangolo deve contenerli.
- Meglio poche sezioni larghe che molte strette: un rettangolo troppo stretto costringe i pezzi in fila indiana e allunga tutto.

Regole geometriche, non negoziabili:
- Ogni rettangolo sta dentro il contorno della scheda, con il margine indicato.
- I rettangoli NON si sovrappongono fra loro.
- Ogni rettangolo ha almeno il DOPPIO dell'area occupata dai suoi pezzi: sotto quella soglia non c'e' spazio per far passare le piste.
- Coordinate in millimetri, nello stesso sistema della scheda (origine al centro, y verso l'alto).

Rispondi chiamando lo strumento pianta, in italiano, senza em-dash.`;

function messaggio(
  board: { width: number; height: number; centerX: number; centerY: number },
  margine: number,
  sezioni: SezioneRichiesta[],
  problemi: string[],
): string {
  const righe = sezioni.map((s) => {
    const legami = Object.entries(s.legami)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([n, k]) => `${n}:${k}`)
      .join(", ");
    const fermi = s.fermi.length
      ? ` | fermi a mano: ${s.fermi.map((f) => `${f.nome} in (${f.x.toFixed(1)}, ${f.y.toFixed(1)})`).join("; ")}`
      : "";
    return `- ${s.nome}: ${s.componenti.length} pezzi, area occupata ${s.areaMm2.toFixed(1)}mm2, quindi almeno ${(s.areaMm2 * 2).toFixed(0)}mm2 di rettangolo | pezzi: ${s.componenti.join(" ")} | legami [${legami || "nessuno"}]${fermi}`;
  });
  const half = { w: board.width / 2, h: board.height / 2 };
  return [
    `Scheda ${board.width}x${board.height}mm, centro in (${board.centerX}, ${board.centerY}): x va da ${(board.centerX - half.w + margine).toFixed(1)} a ${(board.centerX + half.w - margine).toFixed(1)}, y da ${(board.centerY - half.h + margine).toFixed(1)} a ${(board.centerY + half.h - margine).toFixed(1)} (margine ${margine}mm dal bordo).`,
    "",
    "Sezioni da collocare:",
    ...righe,
    problemi.length
      ? `\nIl piano precedente non andava bene:\n${problemi.map((p) => `- ${p}`).join("\n")}\nRifallo tenendo conto di questi problemi.`
      : "",
  ].join("\n");
}

/** what does not hold up geometrically, said in words the model can act on */
function problemiDelPiano(
  sezioni: Sezione[],
  richieste: SezioneRichiesta[],
  board: { width: number; height: number; centerX: number; centerY: number },
  margine: number,
): string[] {
  const out: string[] = [];
  const minX = board.centerX - board.width / 2 + margine;
  const maxX = board.centerX + board.width / 2 - margine;
  const minY = board.centerY - board.height / 2 + margine;
  const maxY = board.centerY + board.height / 2 - margine;

  const perNome = new Map(richieste.map((r) => [r.nome.toLowerCase(), r]));
  for (const r of richieste) {
    if (!sezioni.some((s) => s.nome.toLowerCase() === r.nome.toLowerCase())) {
      out.push(`manca la sezione ${r.nome}`);
    }
  }
  for (const s of sezioni) {
    const req = perNome.get(s.nome.toLowerCase());
    if (!req) {
      out.push(`la sezione ${s.nome} non esiste: le sezioni sono ${richieste.map((r) => r.nome).join(", ")}`);
      continue;
    }
    if (s.maxX <= s.minX || s.maxY <= s.minY) {
      out.push(`la sezione ${s.nome} ha un rettangolo rovesciato o nullo`);
      continue;
    }
    if (s.minX < minX - 0.01 || s.maxX > maxX + 0.01 || s.minY < minY - 0.01 || s.maxY > maxY + 0.01) {
      out.push(
        `la sezione ${s.nome} esce dalla scheda: x [${s.minX}, ${s.maxX}] y [${s.minY}, ${s.maxY}], ma lo spazio utile e' x [${minX.toFixed(1)}, ${maxX.toFixed(1)}] y [${minY.toFixed(1)}, ${maxY.toFixed(1)}]`,
      );
    }
    const area = (s.maxX - s.minX) * (s.maxY - s.minY);
    if (area < req.areaMm2 * 2) {
      out.push(
        `la sezione ${s.nome} e' troppo stretta: ${area.toFixed(0)}mm2 per pezzi che ne occupano ${req.areaMm2.toFixed(0)}, servono almeno ${(req.areaMm2 * 2).toFixed(0)}mm2`,
      );
    }
    for (const f of req.fermi) {
      if (f.x < s.minX - 0.01 || f.x > s.maxX + 0.01 || f.y < s.minY - 0.01 || f.y > s.maxY + 0.01) {
        out.push(
          `${f.nome} e' fissato a mano in (${f.x.toFixed(1)}, ${f.y.toFixed(1)}) e appartiene a ${s.nome}: il rettangolo deve contenerlo`,
        );
      }
    }
  }
  for (let i = 0; i < sezioni.length; i++) {
    for (let j = i + 1; j < sezioni.length; j++) {
      const a = sezioni[i];
      const b = sezioni[j];
      const sovrX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const sovrY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      if (sovrX > 0.01 && sovrY > 0.01) {
        out.push(
          `le sezioni ${a.nome} e ${b.nome} si sovrappongono per ${sovrX.toFixed(1)}x${sovrY.toFixed(1)}mm`,
        );
      }
    }
  }
  return out;
}

/**
 * Asks the model for the floorplan and returns it only if it holds up. Up to
 * `giri` attempts, each one told what was wrong with the previous.
 */
export async function pianificaSezioni({
  board,
  sezioni,
  margine = 1,
  giri = 3,
  keys,
}: {
  board: { width: number; height: number; centerX: number; centerY: number };
  sezioni: SezioneRichiesta[];
  margine?: number;
  giri?: number;
  keys?: AgentKeyMap;
}): Promise<PianoSezioni> {
  if (sezioni.length === 0) throw new Error("nessuna sezione da collocare");
  const problemi: string[] = [];
  let ultimoProvider = "";

  for (let giro = 1; giro <= giri; giro++) {
    const turno = await runAgentTurn(
      {
        system: SISTEMA,
        tools: [
          {
            name: "pianta",
            description: "La divisione della scheda in sezioni, un rettangolo per sezione.",
            input_schema: SCHEMA,
          },
        ],
        messages: [{ role: "user", content: messaggio(board, margine, sezioni, problemi) }],
      },
      { keys },
    );
    ultimoProvider = turno.provider;
    const uso = turno.content.find(
      (c): c is Extract<typeof c, { type: "tool_use" }> => c.type === "tool_use",
    );
    if (!uso) {
      problemi.length = 0;
      problemi.push("non hai chiamato lo strumento pianta: devi rispondere con quello");
      continue;
    }
    const dati = uso.input as { ragionamento?: unknown; sezioni?: unknown };
    const lista = Array.isArray(dati.sezioni) ? (dati.sezioni as Sezione[]) : [];
    const guai = problemiDelPiano(lista, sezioni, board, margine);
    if (guai.length === 0) {
      return {
        sezioni: lista,
        ragionamento: typeof dati.ragionamento === "string" ? dati.ragionamento : "",
        provider: turno.provider,
        tentativi: giro,
      };
    }
    problemi.length = 0;
    problemi.push(...guai);
  }

  throw new Error(
    `il piano delle sezioni non regge dopo ${giri} tentativi (${ultimoProvider}): ${problemi.join("; ")}`,
  );
}
