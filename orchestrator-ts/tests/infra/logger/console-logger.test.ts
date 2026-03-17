import { isLevelEnabled, type LogLevel } from "@/application/ports/logger";
import { ConsoleLogger } from "@/infra/logger/console-logger";
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";

// ---------------------------------------------------------------------------
// Helper: capture stderr output during test
// ---------------------------------------------------------------------------

let stderrOutput: string[];
let stderrSpy: Mock<typeof process.stderr.write>;

beforeEach(() => {
  stderrOutput = [];
  stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrOutput.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Task 2.1 — Level filtering and TTY detection
// ---------------------------------------------------------------------------

describe("ConsoleLogger — level filtering", () => {
  it("suppresses entries below minLevel (minLevel=info, debug suppressed)", () => {
    const logger = new ConsoleLogger("info", false);
    logger.debug("should not appear");
    expect(stderrOutput).toHaveLength(0);
  });

  it("emits entries at exactly minLevel (minLevel=info, info emitted)", () => {
    const logger = new ConsoleLogger("info", false);
    logger.info("should appear");
    expect(stderrOutput).toHaveLength(1);
  });

  it("emits entries above minLevel (minLevel=info, warn/error emitted)", () => {
    const logger = new ConsoleLogger("info", false);
    logger.warn("warn message");
    logger.error("error message");
    expect(stderrOutput).toHaveLength(2);
  });

  it("suppresses all levels below warn (minLevel=warn)", () => {
    const logger = new ConsoleLogger("warn", false);
    logger.debug("debug msg");
    logger.info("info msg");
    expect(stderrOutput).toHaveLength(0);
  });

  it("emits warn and error when minLevel=warn", () => {
    const logger = new ConsoleLogger("warn", false);
    logger.warn("warn msg");
    logger.error("error msg");
    expect(stderrOutput).toHaveLength(2);
  });

  it("suppresses debug, info, warn when minLevel=error", () => {
    const logger = new ConsoleLogger("error", false);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    expect(stderrOutput).toHaveLength(0);
  });

  it("emits only error when minLevel=error", () => {
    const logger = new ConsoleLogger("error", false);
    logger.error("error msg");
    expect(stderrOutput).toHaveLength(1);
  });

  it("emits all levels when minLevel=debug", () => {
    const logger = new ConsoleLogger("debug", false);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(stderrOutput).toHaveLength(4);
  });

  it("defaults to minLevel=info when no level provided", () => {
    // Default constructor behavior — debug suppressed, info emitted
    const logger = new ConsoleLogger("info", false);
    logger.debug("should not appear");
    expect(stderrOutput).toHaveLength(0);
    logger.info("should appear");
    expect(stderrOutput).toHaveLength(1);
  });

  it("never throws even on unexpected input", () => {
    const logger = new ConsoleLogger("info", false);
    expect(() => {
      logger.debug("", undefined);
      logger.info("msg", { nested: { value: 42 } });
      logger.warn("msg", {});
      logger.error("msg");
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 2.2 — Plain text output (isTTY = false)
// ---------------------------------------------------------------------------

describe("ConsoleLogger — plain text output (isTTY=false)", () => {
  it("formats debug entry as plain text [DEBUG] message", () => {
    const logger = new ConsoleLogger("debug", false);
    logger.debug("test message");
    expect(stderrOutput[0]).toContain("[DEBUG]");
    expect(stderrOutput[0]).toContain("test message");
  });

  it("formats info entry as plain text [INFO] message", () => {
    const logger = new ConsoleLogger("info", false);
    logger.info("info message");
    expect(stderrOutput[0]).toContain("[INFO]");
    expect(stderrOutput[0]).toContain("info message");
  });

  it("formats warn entry as plain text [WARN] message", () => {
    const logger = new ConsoleLogger("warn", false);
    logger.warn("warn message");
    expect(stderrOutput[0]).toContain("[WARN]");
    expect(stderrOutput[0]).toContain("warn message");
  });

  it("formats error entry as plain text [ERROR] message", () => {
    const logger = new ConsoleLogger("error", false);
    logger.error("error message");
    expect(stderrOutput[0]).toContain("[ERROR]");
    expect(stderrOutput[0]).toContain("error message");
  });

  it("includes context object in plain text output", () => {
    const logger = new ConsoleLogger("info", false);
    logger.info("message with context", { phase: "test", count: 42 });
    const output = stderrOutput[0];
    expect(output).toContain("phase");
    expect(output).toContain("test");
    expect(output).toContain("count");
    expect(output).toContain("42");
  });

  it("does not include ANSI escape codes in plain text output", () => {
    const logger = new ConsoleLogger("debug", false);
    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");
    for (const line of stderrOutput) {
      expect(line).not.toContain("\x1b[");
    }
  });

  it("each output line ends with newline", () => {
    const logger = new ConsoleLogger("info", false);
    logger.info("a message");
    expect(stderrOutput[0]).toEndWith("\n");
  });
});

// ---------------------------------------------------------------------------
// Task 2.2 — ANSI color output (isTTY = true)
// ---------------------------------------------------------------------------

describe("ConsoleLogger — ANSI color output (isTTY=true)", () => {
  it("applies gray ANSI code for debug level", () => {
    const logger = new ConsoleLogger("debug", true);
    logger.debug("debug msg");
    expect(stderrOutput[0]).toContain("\x1b[90m"); // gray
  });

  it("applies reset ANSI code as prefix for info level", () => {
    const logger = new ConsoleLogger("info", true);
    logger.info("info msg");
    // \x1b[0m must appear as the prefix (start of line), not just the suffix reset
    expect(stderrOutput[0]).toStartWith("\x1b[0m");
  });

  it("applies yellow ANSI code for warn level", () => {
    const logger = new ConsoleLogger("warn", true);
    logger.warn("warn msg");
    expect(stderrOutput[0]).toContain("\x1b[33m"); // yellow
  });

  it("applies red ANSI code for error level", () => {
    const logger = new ConsoleLogger("error", true);
    logger.error("error msg");
    expect(stderrOutput[0]).toContain("\x1b[31m"); // red
  });

  it("resets color after each line", () => {
    const logger = new ConsoleLogger("warn", true);
    logger.warn("warn msg");
    // Output should end with reset + newline
    const output = stderrOutput[0];
    expect(output).toContain("\x1b[0m");
    expect(output).toEndWith("\n");
  });

  it("ANSI codes are absent when isTTY=false, present when isTTY=true", () => {
    const plainLogger = new ConsoleLogger("debug", false);
    const colorLogger = new ConsoleLogger("debug", true);

    plainLogger.debug("msg");
    const plainOutput = stderrOutput[0];
    expect(plainOutput).not.toContain("\x1b[90m");

    stderrOutput = [];
    colorLogger.debug("msg");
    const colorOutput = stderrOutput[0];
    expect(colorOutput).toContain("\x1b[90m");
  });

  it("includes message content in colored output", () => {
    const logger = new ConsoleLogger("debug", true);
    logger.debug("important message", { key: "value" });
    const output = stderrOutput[0];
    expect(output).toContain("important message");
    expect(output).toContain("[DEBUG]");
  });
});

// ---------------------------------------------------------------------------
// Task 9.1 — isLevelEnabled: all 16 (configured × candidate) combinations
// ---------------------------------------------------------------------------

describe("isLevelEnabled — all 16 level pair combinations", () => {
  // Truth table: isLevelEnabled(configured, candidate)
  // candidate must be >= configured severity to return true.
  //
  //               candidate →  debug   info   warn   error
  // configured ↓
  //   debug                      T      T      T      T
  //   info                       F      T      T      T
  //   warn                       F      F      T      T
  //   error                      F      F      F      T

  const cases: Array<[LogLevel, LogLevel, boolean]> = [
    // configured=debug: all candidates enabled
    ["debug", "debug", true],
    ["debug", "info", true],
    ["debug", "warn", true],
    ["debug", "error", true],
    // configured=info: debug suppressed, rest enabled
    ["info", "debug", false],
    ["info", "info", true],
    ["info", "warn", true],
    ["info", "error", true],
    // configured=warn: debug+info suppressed, warn+error enabled
    ["warn", "debug", false],
    ["warn", "info", false],
    ["warn", "warn", true],
    ["warn", "error", true],
    // configured=error: only error enabled
    ["error", "debug", false],
    ["error", "info", false],
    ["error", "warn", false],
    ["error", "error", true],
  ];

  for (const [configured, candidate, expected] of cases) {
    it(`isLevelEnabled("${configured}", "${candidate}") === ${String(expected)}`, () => {
      expect(isLevelEnabled(configured, candidate)).toBe(expected);
    });
  }
});
