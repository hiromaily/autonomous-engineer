// biome-ignore lint/correctness/noUnusedImports: LogContext is used in inline parameter type annotations; biome false positive
import type { ILogger, LogContext, LogLevel } from "@/application/ports/logger";
import { isLevelEnabled, LOG_LEVEL_ORDER } from "@/application/ports/logger";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// ILogger structural compliance
// ---------------------------------------------------------------------------

describe("ILogger structural compliance", () => {
  it("a conforming logger implements all four methods without throwing", () => {
    const calls: string[] = [];

    const logger: ILogger = {
      debug(message: string, _context?: LogContext): void {
        calls.push(`debug:${message}`);
      },
      info(message: string, _context?: LogContext): void {
        calls.push(`info:${message}`);
      },
      warn(message: string, _context?: LogContext): void {
        calls.push(`warn:${message}`);
      },
      error(message: string, _context?: LogContext): void {
        calls.push(`error:${message}`);
      },
    };

    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    expect(calls).toEqual([
      "debug:debug message",
      "info:info message",
      "warn:warn message",
      "error:error message",
    ]);
  });

  it("accepts optional context object on all methods", () => {
    const contexts: LogContext[] = [];

    const logger: ILogger = {
      debug(_msg, ctx?: LogContext): void {
        if (ctx) contexts.push(ctx);
      },
      info(_msg, ctx?: LogContext): void {
        if (ctx) contexts.push(ctx);
      },
      warn(_msg, ctx?: LogContext): void {
        if (ctx) contexts.push(ctx);
      },
      error(_msg, ctx?: LogContext): void {
        if (ctx) contexts.push(ctx);
      },
    };

    const ctx: LogContext = { phase: "test", specName: "my-spec" };
    logger.debug("d", ctx);
    logger.info("i", ctx);
    logger.warn("w", ctx);
    logger.error("e", ctx);

    expect(contexts).toHaveLength(4);
    expect(contexts[0]).toEqual({ phase: "test", specName: "my-spec" });
  });

  it("all four methods are optional context — works with no context", () => {
    const logger: ILogger = {
      debug(): void {},
      info(): void {},
      warn(): void {},
      error(): void {},
    };

    expect(() => {
      logger.debug("msg");
      logger.info("msg");
      logger.warn("msg");
      logger.error("msg");
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// LogLevel type
// ---------------------------------------------------------------------------

describe("LogLevel type", () => {
  it("LOG_LEVEL_ORDER contains exactly four levels in ascending severity order", () => {
    expect(LOG_LEVEL_ORDER).toEqual(["debug", "info", "warn", "error"]);
    expect(LOG_LEVEL_ORDER).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// isLevelEnabled — all 16 combinations of (configured, candidate)
// ---------------------------------------------------------------------------

describe("isLevelEnabled", () => {
  // When configured = "debug", everything is enabled
  it("configured=\"debug\", candidate=\"debug\" → true", () => {
    expect(isLevelEnabled("debug", "debug")).toBe(true);
  });
  it("configured=\"debug\", candidate=\"info\" → true", () => {
    expect(isLevelEnabled("debug", "info")).toBe(true);
  });
  it("configured=\"debug\", candidate=\"warn\" → true", () => {
    expect(isLevelEnabled("debug", "warn")).toBe(true);
  });
  it("configured=\"debug\", candidate=\"error\" → true", () => {
    expect(isLevelEnabled("debug", "error")).toBe(true);
  });

  // When configured = "info", debug is suppressed
  it("configured=\"info\", candidate=\"debug\" → false", () => {
    expect(isLevelEnabled("info", "debug")).toBe(false);
  });
  it("configured=\"info\", candidate=\"info\" → true", () => {
    expect(isLevelEnabled("info", "info")).toBe(true);
  });
  it("configured=\"info\", candidate=\"warn\" → true", () => {
    expect(isLevelEnabled("info", "warn")).toBe(true);
  });
  it("configured=\"info\", candidate=\"error\" → true", () => {
    expect(isLevelEnabled("info", "error")).toBe(true);
  });

  // When configured = "warn", debug and info are suppressed
  it("configured=\"warn\", candidate=\"debug\" → false", () => {
    expect(isLevelEnabled("warn", "debug")).toBe(false);
  });
  it("configured=\"warn\", candidate=\"info\" → false", () => {
    expect(isLevelEnabled("warn", "info")).toBe(false);
  });
  it("configured=\"warn\", candidate=\"warn\" → true", () => {
    expect(isLevelEnabled("warn", "warn")).toBe(true);
  });
  it("configured=\"warn\", candidate=\"error\" → true", () => {
    expect(isLevelEnabled("warn", "error")).toBe(true);
  });

  // When configured = "error", only error is enabled
  it("configured=\"error\", candidate=\"debug\" → false", () => {
    expect(isLevelEnabled("error", "debug")).toBe(false);
  });
  it("configured=\"error\", candidate=\"info\" → false", () => {
    expect(isLevelEnabled("error", "info")).toBe(false);
  });
  it("configured=\"error\", candidate=\"warn\" → false", () => {
    expect(isLevelEnabled("error", "warn")).toBe(false);
  });
  it("configured=\"error\", candidate=\"error\" → true", () => {
    expect(isLevelEnabled("error", "error")).toBe(true);
  });
});
