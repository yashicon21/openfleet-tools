// Free-text parts of a run for `openfleet report`: known `## ` sections of summary.md and spec.md,
// and a small Markdown-to-HTML renderer (escapes everything; no raw HTML passes through).

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Split Markdown into `## ` sections: heading text → body. The H1 is returned as `title`. */
export function sections(md: string): { title?: string; sections: { heading: string; body: string }[] } {
  const out: { heading: string; body: string }[] = [];
  let title: string | undefined;
  let cur: { heading: string; lines: string[] } | undefined;
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence) {
      const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
      if (h1 && title === undefined && !cur) {
        title = h1[1];
        continue;
      }
      const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
      if (h2) {
        if (cur) out.push({ heading: cur.heading, body: cur.lines.join("\n").trim() });
        cur = { heading: h2[1]!, lines: [] };
        continue;
      }
    }
    cur?.lines.push(line);
  }
  if (cur) out.push({ heading: cur.heading, body: cur.lines.join("\n").trim() });
  return { title, sections: out };
}

export type SummaryKey = "coverage" | "assumptions" | "followUps" | "lessons";

const KNOWN: [SummaryKey, RegExp][] = [
  ["coverage", /^coverage\b/i],
  ["assumptions", /^assumptions\b/i],
  ["followUps", /^follow[- ]?ups\b/i],
  ["lessons", /^lessons\b/i],
];

/** Bodies of the known summary.md headings (`## Coverage`, `## Assumptions`, `## Follow-ups`, `## Lessons`). */
export function summarySections(md: string): Partial<Record<SummaryKey, string>> {
  const out: Partial<Record<SummaryKey, string>> = {};
  for (const s of sections(md).sections) {
    const hit = KNOWN.find(([, re]) => re.test(s.heading.trim()));
    if (hit && s.body && out[hit[0]] === undefined) out[hit[0]] = s.body;
  }
  return out;
}

/** Goal of the spec: the `## Goal` section, else the first paragraph after the title. */
export function specAsk(md: string): { title?: string; goal?: string } {
  const { title, sections: secs } = sections(md);
  const goal = secs.find((s) => /^goal\b/i.test(s.heading))?.body;
  if (goal) return { title, goal };
  const body = md.replace(/^#\s+.*\n/, "").trim();
  const first = body.split(/\n\s*\n/).find((p) => p.trim() && !p.trim().startsWith("#"));
  return { title, goal: first?.trim() };
}

function inline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t: string, u: string) => `<a href="${u}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>");
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Render a Markdown subset: headings (as h4), paragraphs, lists, tables, code fences, quotes. */
export function markdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*(```|~~~)/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      html.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^#{1,6}\s+(.+)$/.exec(line);
    if (h) {
      html.push(`<h4>${inline(h[1]!)}</h4>`);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      html.push(
        `<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table></div>",
      );
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+/;
    if (li.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && (li.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const l = lines[i++]!;
        if (li.test(l) && !/^\s{2,}/.test(l)) items.push(l.replace(li, ""));
        else items[items.length - 1] += " " + l.trim().replace(li, "");
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      html.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*(```|~~~|#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>)/.test(lines[i]!)) {
      para.push(lines[i++]!.trim());
    }
    if (!para.length) para.push(lines[i++]!.trim());
    html.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return html.join("\n");
}
