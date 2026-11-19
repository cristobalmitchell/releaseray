import type { LogRecord, LogSink } from "../core/logger";

/**
 * The part of `@actions/core` the log sink writes to. Declared structurally so
 * tests can pass a fake, and so the core never imports `@actions/core`.
 */
export interface ActionsLogApi {
  debug(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

/**
 * Formats a record as one workflow-log line: `[service] message {meta}`.
 *
 * @param record - A log record from the core logger
 * @returns The line to write
 */
export function formatRecord(record: LogRecord): string {
  const meta = Object.keys(record.meta).length > 0 ? ` ${JSON.stringify(record.meta)}` : "";
  return `[${record.service}] ${record.message}${meta}`;
}

/**
 * Builds the sink the entry layer passes to `configureLogger`. Levels map to
 * `core.debug`, `core.info`, `core.warning` and `core.error`, so warnings and
 * errors become annotations and debug lines follow the runner's step-debug
 * setting.
 *
 * @param core - `@actions/core`, or a fake in tests
 * @returns A log sink
 */
export function createActionsLogSink(core: ActionsLogApi): LogSink {
  return (record) => {
    const line = formatRecord(record);
    switch (record.level) {
      case "debug":
        core.debug(line);
        break;
      case "info":
        core.info(line);
        break;
      case "warn":
        core.warning(line);
        break;
      case "error":
        core.error(line);
        break;
    }
  };
}
