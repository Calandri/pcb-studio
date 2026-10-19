import { neon } from "@neondatabase/serverless";

/**
 * The feedback widget's backend: turns a visitor's note into a GitHub issue
 * on the project's repo, with light but real anti-abuse protection.
 *
 * The endpoint is public (the widget also shows on the logged-out landing),
 * so the defense is layered: a honeypot field in the form, per-IP rate
 * limiting in the database, and labels created upfront so issues land on the
 * board already tagged.
 */

export const FEEDBACK_KINDS = ["bug", "idea", "feedback"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

const REPO = "Calandri/pcb-studio";
const LABEL_BY_KIND: Record<FeedbackKind, string> = {
  bug: "bug",
  idea: "enhancement",
  feedback: "feedback",
};
const WIDGET_LABEL = "widget";
const MAX_PER_IP_PER_HOUR = 5;

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

async function ensureTable(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS feedback_submissions (
      id bigserial PRIMARY KEY,
      ip text NOT NULL,
      issue_number integer,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

/**
 * Takes one slot of this IP's hourly budget, or returns null when it is spent.
 * The slot is written BEFORE the work: counting only the finished submissions
 * let a burst of parallel requests all see the budget still free.
 */
async function takeSlot(ip: string): Promise<{ id: string } | null | "no-db"> {
  const sql = db();
  if (!sql) return "no-db"; // no DB: fail open, GitHub's own limits still apply
  await ensureTable(sql);
  const [slot] = (await sql`
    INSERT INTO feedback_submissions (ip) VALUES (${ip}) RETURNING id
  `) as Array<{ id: string }>;
  const [row] = (await sql`
    SELECT count(*) AS n FROM feedback_submissions
    WHERE ip = ${ip} AND created_at > now() - interval '1 hour'
  `) as Array<{ n: string }>;
  return Number(row.n) > MAX_PER_IP_PER_HOUR ? null : { id: String(slot.id) };
}

async function record(slotId: string, issueNumber: number): Promise<void> {
  const sql = db();
  if (!sql) return;
  try {
    await sql`UPDATE feedback_submissions SET issue_number = ${issueNumber} WHERE id = ${slotId}`;
  } catch {
    // losing the issue number only loses a cross-reference, not the submission
  }
}

async function gh(path: string, init?: RequestInit): Promise<Response> {
  const token = process.env.GITHUB_FEEDBACK_TOKEN;
  if (!token) throw new Error("GITHUB_FEEDBACK_TOKEN non configurato");
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
}

/** the labels the board filters on; created once, then 422 = already there */
async function ensureLabels(): Promise<void> {
  const wanted = [
    { name: WIDGET_LABEL, color: "7C5CE0", description: "Arriva dal widget in app" },
    { name: "feedback", color: "3BE8B0", description: "Feedback generico dal widget" },
    { name: "bug", color: "D73A4A", description: "Qualcosa non funziona" },
    { name: "enhancement", color: "A2EEFB", description: "Richiesta di funzionalita'" },
  ];
  for (const label of wanted) {
    await gh(`/repos/${REPO}/labels`, { method: "POST", body: JSON.stringify(label) }).catch(
      () => {},
    );
  }
}

export interface FeedbackInput {
  kind: FeedbackKind;
  title: string;
  body: string;
  page?: string;
  /** jpeg base64, no data: prefix; capped server-side */
  screenshotBase64?: string;
  /** the element the user pointed at, when they used the selector */
  component?: {
    tag: string;
    id: string | null;
    classes: string[];
    xpath: string;
    text_content: string | null;
  };
  pageTitle?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
}

/** screenshots live here: the issue links them, GitHub never sees the bytes */
async function ensureShotTable(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS feedback_screenshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      content_type text NOT NULL DEFAULT 'image/jpeg',
      data text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

const MAX_SHOT_BASE64 = 550_000; // ~400KB jpeg

/** the bytes really are a JPEG (FF D8 FF): the GET serves them as image/jpeg */
function isJpegBase64(base64: string): boolean {
  const head = Buffer.from(base64.slice(0, 8), "base64");
  return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

async function saveScreenshot(base64: string): Promise<string | null> {
  const sql = db();
  if (!sql) return null;
  if (base64.length > MAX_SHOT_BASE64 || !isJpegBase64(base64)) return null;
  try {
    await ensureShotTable(sql);
    const [row] = (await sql`
      INSERT INTO feedback_screenshots (data) VALUES (${base64}) RETURNING id
    `) as Array<{ id: string }>;
    return String(row.id);
  } catch {
    return null;
  }
}

export async function getScreenshot(
  id: string,
): Promise<{ contentType: string; data: string } | null> {
  const sql = db();
  if (!sql || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    await ensureShotTable(sql);
    const [row] = (await sql`
      SELECT content_type, data FROM feedback_screenshots WHERE id = ${id} LIMIT 1
    `) as Array<{ content_type: string; data: string }>;
    return row ? { contentType: row.content_type, data: row.data } : null;
  } catch {
    return null;
  }
}

/**
 * Creates the GitHub issue. Returns the issue number and URL so the widget
 * can say "yours is #123" with a link. `origin` is the deployment's own URL,
 * used to build the screenshot link hosted by the app itself.
 */
export async function createFeedbackIssue(
  ip: string,
  input: FeedbackInput,
  origin: string,
): Promise<{ number: number; url: string }> {
  const slot = await takeSlot(ip);
  if (slot === null) {
    throw new Error("troppi messaggi di fila: riprova tra un po'");
  }
  await ensureLabels();

  const shotId = input.screenshotBase64 ? await saveScreenshot(input.screenshotBase64) : null;
  const bodyParts: string[] = [input.body.slice(0, 4000), ""];

  if (input.component) {
    const c = input.component;
    bodyParts.push(
      "**Elemento segnalato**",
      `- \`${c.tag}\`${c.id ? ` #${c.id}` : ""} — \`${c.xpath.slice(0, 300)}\``,
      ...(c.text_content ? [`- testo: "${c.text_content}"`] : []),
      "",
    );
  }
  if (shotId) {
    bodyParts.push(
      "**Screenshot**",
      `![screenshot](${origin}/api/feedback?id=${shotId})`,
      "",
    );
  }
  bodyParts.push("---");
  const ctx = [
    input.page ? `pagina: ${input.page.slice(0, 120)}` : null,
    input.pageTitle ? `titolo: ${input.pageTitle.slice(0, 120)}` : null,
    input.viewport ? `viewport: ${input.viewport.width}×${input.viewport.height}` : null,
    input.userAgent ? `ua: ${input.userAgent.slice(0, 160)}` : null,
  ].filter(Boolean);
  bodyParts.push(`_inviato dal widget in app${ctx.length ? ` · ${ctx.join(" · ")}` : ""}_`);

  const res = await gh(`/repos/${REPO}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: input.title.slice(0, 200),
      body: bodyParts.join("\n"),
      labels: [WIDGET_LABEL, LABEL_BY_KIND[input.kind]],
    }),
  });
  if (!res.ok) {
    // the GitHub answer stays in the server log: the endpoint is anonymous,
    // and upstream error bodies are not for whoever is on the other side
    const text = await res.text().catch(() => "");
    console.error(`[feedback] github HTTP ${res.status}: ${text.slice(0, 500)}`);
    throw new Error("invio non riuscito: riprova tra qualche minuto");
  }
  const issue = (await res.json()) as { number: number; html_url: string };
  if (slot !== "no-db") await record(slot.id, issue.number);
  return { number: issue.number, url: issue.html_url };
}
