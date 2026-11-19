import { afterEach, describe, expect, it, vi } from "vitest";
import { configureLogger, createLogger, resetLogger, type LogRecord } from "../../src/core/logger";
import { createActionsLogSink, formatRecord } from "../../src/action/logger-sink";

// Created at module load, before any configureLogger call, like the loggers
// in the lifted llm modules.
const earlyLogger = createLogger("early");

function fakeCore() {
  return { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() };
}

afterEach(() => resetLogger());

describe("configureLogger", () => {
  it("sends debug lines to the Action sink only at level debug", () => {
    const core = fakeCore();
    configureLogger({ level: "info", sink: createActionsLogSink(core) });
    earlyLogger.debug("hidden");
    earlyLogger.info("shown");
    expect(core.debug).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith("[early] shown");

    configureLogger({ level: "debug" });
    earlyLogger.debug("now shown");
    expect(core.debug).toHaveBeenCalledWith("[early] now shown");
  });

  it("maps warn and error to core.warning and core.error", () => {
    const core = fakeCore();
    configureLogger({ level: "debug", sink: createActionsLogSink(core) });
    const logger = createLogger("llm");
    logger.warn("slow", { ms: 900 });
    logger.error("failed");
    expect(core.warning).toHaveBeenCalledWith('[llm] slow {"ms":900}');
    expect(core.error).toHaveBeenCalledWith("[llm] failed");
  });

  it("drops levels below the configured level", () => {
    const records: LogRecord[] = [];
    configureLogger({ level: "warn", sink: (r) => records.push(r) });
    const logger = createLogger("x");
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(records.map((r) => r.message)).toEqual(["c", "d"]);
  });

  it("redacts sensitive keys before the sink sees them", () => {
    const records: LogRecord[] = [];
    configureLogger({ sink: (r) => records.push(r) });
    createLogger("x", { apiKey: "abc" }).info("call", { nested: { token: "t", ok: 1 } });
    expect(records[0].meta).toEqual({
      apiKey: "[REDACTED]",
      nested: { token: "[REDACTED]", ok: 1 },
    });
  });

  it("keeps child context", () => {
    const records: LogRecord[] = [];
    configureLogger({ sink: (r) => records.push(r) });
    createLogger("x").child({ persona: "engineer" }).info("go");
    expect(records[0]).toMatchObject({
      service: "x",
      message: "go",
      meta: { persona: "engineer" },
    });
  });

  it("defaults to level info", () => {
    const records: LogRecord[] = [];
    configureLogger({ sink: (r) => records.push(r) });
    earlyLogger.debug("no");
    earlyLogger.info("yes");
    expect(records.map((r) => r.message)).toEqual(["yes"]);
  });
});

describe("formatRecord", () => {
  it("omits empty metadata", () => {
    expect(
      formatRecord({ level: "info", service: "s", message: "m", meta: {}, timestamp: "t" })
    ).toBe("[s] m");
  });
});
