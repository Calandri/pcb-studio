"use client";

import type { ReactNode } from "react";

/**
 * Renderer markdown minimale che produce ELEMENTI REACT, non HTML.
 * Scelta deliberata: il testo arriva da un LLM che elabora anche contenuti non
 * fidati (datasheet, risultati di ricerca), quindi niente dangerouslySetInnerHTML.
 * Copre quello che il modello usa davvero: titoli, liste, tabelle, codice, bold.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="space-y-2">{parseBlocks(text)}</div>;
}

function parseBlocks(text: string): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // blocco di codice
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-md border border-edge bg-substrate p-2.5 font-mono text-[11px] leading-relaxed text-dim"
        >
          {body.join("\n")}
        </pre>,
      );
      continue;
    }

    // tabella
    if (line.includes("|") && lines[i + 1]?.match(/^\s*\|?[\s:|-]+\|/)) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|")) {
        const cells = lines[i]
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c) || c === "")) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        <div key={key++} className="overflow-x-auto">
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr>
                {head?.map((c, j) => (
                  <th
                    key={j}
                    className="border-b border-edge px-2 py-1 text-left font-medium text-faint"
                  >
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {row.map((c, j) => (
                    <td key={j} className="border-b border-edge/50 px-2 py-1 text-dim">
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // titolo
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(
        <p
          key={key++}
          className="pt-1 text-[13px] font-semibold tracking-tight text-ink"
        >
          {inline(heading[2])}
        </p>,
      );
      i++;
      continue;
    }

    // lista
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      out.push(
        <ul key={key++} className="space-y-1 pl-1">
          {items.map((it, j) => (
            <li key={j} className="flex gap-2">
              <span className="mt-[7px] h-1 w-1 flex-none rounded-full bg-faint" />
              <span className="min-w-0 flex-1">{inline(it)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // paragrafo
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trimStart().startsWith("```") &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(
      <p key={key++} className="leading-relaxed">
        {inline(para.join(" "))}
      </p>,
    );
  }

  return out;
}

/** bold, codice inline e resto come testo semplice */
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("**")) {
      parts.push(
        <strong key={key++} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      parts.push(
        <code
          key={key++}
          className="rounded bg-substrate px-1 py-0.5 font-mono text-[11px] text-copper"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
