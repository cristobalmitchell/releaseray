/**
 * The runner I/O the entry layer uses, behind an interface so tests can pass
 * a fake instead of `@actions/core`.
 */
import * as core from "@actions/core";

/** What the entry layer reads from and writes to the runner. */
export interface ActionsIO {
  /** Raw input value; `''` when unset or blank. */
  getInput(name: string): string;
  setOutput(name: string, value: string): void;
  /** Appends Markdown to the job summary. */
  writeSummary(markdown: string): Promise<void>;
  error(message: string, title?: string): void;
  warning(message: string, title?: string): void;
  notice(message: string, title?: string): void;
  info(message: string): void;
  debug(message: string): void;
  /** Masks a value in logs. */
  setSecret(value: string): void;
}

/**
 * The real I/O over `@actions/core`.
 *
 * @returns The adapter
 */
export function createActionsIO(): ActionsIO {
  return {
    getInput: (name) => core.getInput(name),
    setOutput: (name, value) => core.setOutput(name, value),
    writeSummary: async (markdown) => {
      await core.summary.addRaw(markdown, true).write();
    },
    error: (message, title) => core.error(message, title ? { title } : {}),
    warning: (message, title) => core.warning(message, title ? { title } : {}),
    notice: (message, title) => core.notice(message, title ? { title } : {}),
    info: (message) => core.info(message),
    debug: (message) => core.debug(message),
    setSecret: (value) => core.setSecret(value),
  };
}
