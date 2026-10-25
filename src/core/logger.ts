/**
 * Core logger
 *
 * Provides structured logging with:
 * - Log levels (debug, info, warn, error)
 * - Sensitive data redaction
 * - Service context for filtering
 *
 * The core reads no environment. The Action entry layer calls
 * `configureLogger({ level, sink })` once per process; tests pass a capturing
 * sink. Loggers read the configuration at log time, so loggers created at
 * module load follow a later `configureLogger` call.
 *
 * @see https://www.npmjs.com/package/pino (inspiration for API design)
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
}

/** One log line, already filtered by level and redacted. */
export interface LogRecord {
  level: LogLevel;
  service: string;
  message: string;
  /** Context and metadata with sensitive values replaced by `[REDACTED]`. */
  meta: LogContext;
  timestamp: string;
}

/** Receives every record at or above the configured level. */
export type LogSink = (record: LogRecord) => void;

export interface LoggerConfig {
  level?: LogLevel;
  sink?: LogSink;
}

/**
 * Default sink: one JSON line per record on the console, as the hosted logger wrote.
 *
 * @param record - The record to write
 */
export const consoleSink: LogSink = (record) => {
  const { meta, ...rest } = record;
  const output = JSON.stringify({ ...rest, ...meta });
  switch (record.level) {
    case "debug":
    case "info":
      console.log(output);
      break;
    case "warn":
      console.warn(output);
      break;
    case "error":
      console.error(output);
      break;
  }
};

const DEFAULT_LEVEL: LogLevel = "info";
let currentLevel: LogLevel = DEFAULT_LEVEL;
let currentSink: LogSink = consoleSink;

/**
 * Sets the level and sink every logger writes through.
 *
 * Called once per process by the Action entry layer. Fields left out keep
 * their current value.
 *
 * @param config - Level and sink
 */
export function configureLogger(config: LoggerConfig): void {
  if (config.level) currentLevel = config.level;
  if (config.sink) currentSink = config.sink;
}

/**
 * Restores the default level (`info`) and the console sink. For tests.
 */
export function resetLogger(): void {
  currentLevel = DEFAULT_LEVEL;
  currentSink = consoleSink;
}

/**
 * Sensitive keys that should be redacted from logs
 */
const SENSITIVE_KEYS = [
  "password",
  "token",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "key",
  "privateKey",
  "private_key",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "sessionId",
  "session_id",
  "cookie",
  "credentials",
  "bearer",
  "jwt",
  "installationToken",
  "webhookSecret",
];

/**
 * Redact sensitive values from log context
 *
 * @param obj - Object to redact
 * @returns Object with sensitive values replaced with [REDACTED]
 */
function redactSensitive(obj: LogContext): LogContext {
  if (!obj || typeof obj !== "object") return obj;

  const redacted: LogContext = {};

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_KEYS.some((sensitiveKey) =>
      lowerKey.includes(sensitiveKey.toLowerCase())
    );

    if (isSensitive) {
      redacted[key] = "[REDACTED]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      // Recursively redact nested objects
      redacted[key] = redactSensitive(value as LogContext);
    } else if (Array.isArray(value)) {
      // Redact array items if they're objects
      redacted[key] = value.map((item) =>
        item && typeof item === "object" ? redactSensitive(item as LogContext) : item
      );
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Check if a log level should be output based on the configured level
 *
 * @param level - Log level to check
 * @returns True if the level should be logged
 */
function shouldLog(level: LogLevel): boolean {
  const levels: LogLevel[] = ["debug", "info", "warn", "error"];
  return levels.indexOf(level) >= levels.indexOf(currentLevel);
}

/**
 * Structured Logger class
 *
 * Writes through the configured sink. Automatically redacts sensitive data
 * and includes timestamps.
 *
 * @example
 * ```typescript
 * const logger = createLogger("github-permissions");
 * logger.info("Permission check", { userId: "123", repoId: "456" });
 * // {"level":"info","service":"github-permissions","message":"Permission check","userId":"123","repoId":"456","timestamp":"2024-01-01T00:00:00.000Z"}
 * ```
 */
export class Logger {
  private service: string;
  private context: LogContext;

  constructor(service: string, context: LogContext = {}) {
    this.service = service;
    this.context = context;
  }

  private log(level: LogLevel, message: string, meta?: LogContext) {
    // Skip if log level is below threshold
    if (!shouldLog(level)) {
      return;
    }

    // Combine context and meta, then redact sensitive values
    const combinedMeta = { ...this.context, ...meta };

    currentSink({
      level,
      service: this.service,
      message,
      meta: redactSensitive(combinedMeta),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Debug logging (disabled in production by default)
   *
   * @param message - Log message
   * @param meta - Additional context
   */
  debug(message: string, meta?: LogContext) {
    this.log("debug", message, meta);
  }

  /**
   * Info logging
   *
   * @param message - Log message
   * @param meta - Additional context
   */
  info(message: string, meta?: LogContext) {
    this.log("info", message, meta);
  }

  /**
   * Warning logging
   *
   * @param message - Log message
   * @param meta - Additional context
   */
  warn(message: string, meta?: LogContext) {
    this.log("warn", message, meta);
  }

  /**
   * Error logging
   *
   * @param message - Log message
   * @param meta - Additional context
   */
  error(message: string, meta?: LogContext) {
    this.log("error", message, meta);
  }

  /**
   * Create a child logger with additional context
   *
   * @param context - Additional context to include in all logs
   * @returns New logger instance with merged context
   */
  child(context: LogContext): Logger {
    return new Logger(this.service, { ...this.context, ...context });
  }
}

/**
 * Create a logger instance with a service name and optional context
 *
 * @param service - Service name for log filtering (e.g., "github-permissions", "llm", "team-sync")
 * @param context - Optional initial context to include in all logs
 * @returns Logger instance
 *
 * @example
 * ```typescript
 * const logger = createLogger("github-permissions");
 * logger.info("Checking permission", { userId: "123" });
 *
 * // With initial context
 * const jobLogger = createLogger("team-sync", { jobId: "job-123" });
 * jobLogger.info("Starting sync"); // Includes jobId in all logs
 * ```
 */
export function createLogger(service: string, context?: LogContext): Logger {
  return new Logger(service, context);
}
