/**
 * Reads what an Actions step leaves behind, the way the runner does: step
 * outputs from the `GITHUB_OUTPUT` file and annotations from the workflow
 * commands the step prints on stdout.
 *
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
 */

/** Annotations a step printed, by kind, with their escapes undone. */
export interface Annotations {
  errors: string[];
  warnings: string[];
  notices: string[];
}

/**
 * Parses a `GITHUB_OUTPUT` file: `name=value` lines and
 * `name<<DELIMITER` … `DELIMITER` blocks, later values winning.
 *
 * @param text - File contents
 * @returns Outputs by name
 */
export function parseOutputFile(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heredoc = /^([^=<]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const [, name, delimiter] = heredoc;
      const value: string[] = [];
      for (i++; i < lines.length && lines[i] !== delimiter; i++) value.push(lines[i]);
      if (i >= lines.length) throw new Error(`Unterminated output ${name}: no ${delimiter}`);
      outputs[name] = value.join("\n");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return outputs;
}

/** Undoes the escaping `@actions/core` applies to command data. */
function unescapeData(data: string): string {
  return data.replace(/%0D/g, "\r").replace(/%0A/g, "\n").replace(/%25/g, "%");
}

/**
 * Collects `::error`, `::warning` and `::notice` commands from stdout.
 *
 * @param stdout - Everything the step printed
 * @returns Annotation messages by kind
 */
export function parseAnnotations(stdout: string): Annotations {
  const out: Annotations = { errors: [], warnings: [], notices: [] };
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^::(error|warning|notice)(?: [^:]*)?::(.*)$/.exec(line);
    if (!m) continue;
    const list = m[1] === "error" ? out.errors : m[1] === "warning" ? out.warnings : out.notices;
    list.push(unescapeData(m[2]));
  }
  return out;
}
