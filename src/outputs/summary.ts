/**
 * The job summary (CONVERSION-PLAN §7.1, §5.8 item 4): each eligible
 * persona's notes, then usage, completeness and warning tables. The entry
 * layer writes it to `$GITHUB_STEP_SUMMARY`.
 */
import type { RunResult } from "../core/run";

/** GitHub rejects a step summary over 1 MiB; stop well before it. */
export const SUMMARY_LIMIT_BYTES = 900 * 1024;

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function cost(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(4)}`;
}

/**
 * Cuts text to a byte budget at a line boundary and says where the rest is.
 *
 * @param text - Summary Markdown
 * @param limit - Byte budget
 * @param pointer - What to tell the reader about the full text
 * @returns The text, truncated when needed
 */
export function truncateSummary(text: string, limit: number, pointer: string): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const note = `\n\n> **Truncated.** ${pointer}\n`;
  const budget = limit - Buffer.byteLength(note, "utf8");
  let cut = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8");
  // Drop a partly decoded last character and the partial last line.
  cut = cut.replace(/�$/, "");
  const lastLine = cut.lastIndexOf("\n");
  if (lastLine > 0) cut = cut.slice(0, lastLine);
  return `${cut}${note}`;
}

/**
 * Renders the job summary.
 *
 * @param result - The run result
 * @param options - `filesDir`, named in the truncation pointer; `latency` shows GitHub request timing
 * @returns Markdown, at most {@link SUMMARY_LIMIT_BYTES}
 */
export function renderSummary(
  result: RunResult,
  options: { filesDir?: string; limitBytes?: number } = {}
): string {
  const { range } = result;
  const lines: string[] = [];
  const span = range.from ? `${range.from} → ${range.to}` : `${range.to} (from the first commit)`;
  lines.push(
    `# ReleaseRay: ${result.key}`,
    "",
    `Range: ${span}, ${range.commits.length} commits.`,
    ""
  );

  if (result.warnings.length > 0) {
    lines.push("> [!WARNING]");
    for (const w of result.warnings) lines.push(`> - ${w}`);
    lines.push("");
  }

  for (const persona of result.personas) {
    if (!persona.sinks.summary) {
      if (persona.withheld.length > 0) lines.push(`_${persona.name}: ${persona.withheld[0]}._`, "");
      continue;
    }
    lines.push(`## ${persona.name}`, "");
    if (persona.text) lines.push(persona.text, "");
    else lines.push("_Not generated in this run._", "");
  }

  const generated = result.personas.filter((p) => p.usage);
  if (generated.length > 0) {
    lines.push(
      "## Usage",
      "",
      "| Persona | Model | Calls | Prompt tokens | Completion tokens | Cost |",
      "| --- | --- | ---: | ---: | ---: | ---: |"
    );
    for (const p of generated) {
      const u = p.usage!;
      lines.push(
        `| ${cell(p.name)} | ${cell(u.model)} | ${u.calls} | ${u.promptTokens} | ${u.completionTokens} | ${cost(u.costUsd)} |`
      );
    }
    lines.push("");
  }

  const gh = result.github;
  const remaining =
    gh.first && gh.latest ? `, remaining ${gh.first.remaining} → ${gh.latest.remaining}` : "";
  lines.push(
    "## GitHub requests",
    "",
    `${gh.total} REST requests${result.estimate !== null ? ` (estimated ${result.estimate})` : ""}, ${gh.retries} retries${remaining}.`,
    ""
  );
  if (result.drops.length > 0)
    lines.push(`Dropped to fit the budget: ${result.drops.join(", ")}.`, "");

  if (result.completeness.length > 0) {
    const counts = new Map<string, number>();
    for (const c of result.completeness) counts.set(c.state, (counts.get(c.state) ?? 0) + 1);
    lines.push(
      "## Pull requests",
      "",
      [...counts.entries()].map(([state, n]) => `${n} ${state}`).join(", ") + ".",
      ""
    );
    const listed = result.completeness.filter((c) => c.state !== "fetched");
    if (listed.length > 0) {
      lines.push("| PR | State | Rule |", "| ---: | --- | --- |");
      for (const c of listed) {
        lines.push(`| #${c.number} | ${c.state} | ${"rule" in c ? cell(c.rule) : ""} |`);
      }
      lines.push("");
    }
  }

  if (result.notices.length > 0) {
    lines.push("<details><summary>Notices</summary>", "");
    for (const n of result.notices) lines.push(`- ${n}`);
    lines.push("", "</details>", "");
  }

  return truncateSummary(
    lines.join("\n"),
    options.limitBytes ?? SUMMARY_LIMIT_BYTES,
    `The full notes are in ${options.filesDir ?? "the workspace notes files"}.`
  );
}
