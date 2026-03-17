import type { ILogger } from "@/application/ports/logger";
import { ToolContextLogger } from "@/application/services/tools/tool-context-logger";
import type { ToolInvocationLog } from "@/domain/tools/types";
import { beforeEach, describe, expect, it, mock } from "bun:test";

function makeLogger(): ILogger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

function makeEntry(overrides: Partial<ToolInvocationLog> = {}): ToolInvocationLog {
  return {
    toolName: "readFile",
    inputSummary: "{\"path\":\"/tmp/foo\"}",
    startedAt: "2026-03-17T00:00:00.000Z",
    durationMs: 42,
    resultStatus: "success",
    outputSize: 128,
    ...overrides,
  };
}

describe("ToolContextLogger", () => {
  let logger: ILogger;
  let toolContextLogger: ToolContextLogger;

  beforeEach(() => {
    logger = makeLogger();
    toolContextLogger = new ToolContextLogger(logger);
  });

  // --- info() forwarding ---

  describe("info()", () => {
    it("forwards to ILogger.debug with tool:<name> message", () => {
      toolContextLogger.info(makeEntry({ toolName: "readFile" }));
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect((logger.debug as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe("tool:readFile");
    });

    it("includes inputSummary, durationMs, and outputSize in context", () => {
      toolContextLogger.info(makeEntry({ inputSummary: "{\"path\":\"/tmp/foo\"}", durationMs: 42, outputSize: 128 }));
      expect((logger.debug as ReturnType<typeof mock>).mock.calls[0]?.[1]).toEqual({
        inputSummary: "{\"path\":\"/tmp/foo\"}",
        durationMs: 42,
        outputSize: 128,
      });
    });

    it("omits outputSize from context when absent in entry", () => {
      const entry: ToolInvocationLog = {
        toolName: "readFile",
        inputSummary: "{\"path\":\"/tmp/foo\"}",
        startedAt: "2026-03-17T00:00:00.000Z",
        durationMs: 42,
        resultStatus: "success",
      };
      toolContextLogger.info(entry);
      expect((logger.debug as ReturnType<typeof mock>).mock.calls[0]?.[1]).toEqual({
        inputSummary: "{\"path\":\"/tmp/foo\"}",
        durationMs: 42,
        outputSize: undefined,
      });
    });

    it("never calls warn or error when forwarding info", () => {
      toolContextLogger.info(makeEntry());
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  // --- error() with resultStatus "runtime" ---

  describe("error() with resultStatus 'runtime'", () => {
    it("forwards to ILogger.error with 'tool:<name> failed' message", () => {
      toolContextLogger.error(makeEntry({ toolName: "shellExec", resultStatus: "runtime", errorMessage: "SIGKILL" }));
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect((logger.error as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe("tool:shellExec failed");
    });

    it("includes inputSummary, durationMs, errorMessage, resultStatus in context", () => {
      toolContextLogger.error(makeEntry({ resultStatus: "runtime", errorMessage: "SIGKILL", durationMs: 10 }));
      expect((logger.error as ReturnType<typeof mock>).mock.calls[0]?.[1]).toEqual({
        inputSummary: "{\"path\":\"/tmp/foo\"}",
        durationMs: 10,
        errorMessage: "SIGKILL",
        resultStatus: "runtime",
      });
    });

    it("never calls warn when resultStatus is 'runtime'", () => {
      toolContextLogger.error(makeEntry({ resultStatus: "runtime" }));
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  // --- error() with resultStatus "permission" ---

  describe("error() with resultStatus 'permission'", () => {
    it("forwards to ILogger.warn with 'tool:<name> failed' message", () => {
      toolContextLogger.error(
        makeEntry({ toolName: "writeFile", resultStatus: "permission", errorMessage: "access denied" }),
      );
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect((logger.warn as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe("tool:writeFile failed");
    });

    it("includes resultStatus 'permission' in context", () => {
      toolContextLogger.error(makeEntry({ resultStatus: "permission", errorMessage: "access denied" }));
      const ctx = (logger.warn as ReturnType<typeof mock>).mock.calls[0]?.[1] as Record<string, unknown>;
      expect(ctx["resultStatus"]).toBe("permission");
    });

    it("never calls error when resultStatus is 'permission'", () => {
      toolContextLogger.error(makeEntry({ resultStatus: "permission" }));
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  // --- error() with resultStatus "validation" ---

  describe("error() with resultStatus 'validation'", () => {
    it("forwards to ILogger.warn for non-runtime status", () => {
      toolContextLogger.error(makeEntry({ resultStatus: "validation", errorMessage: "bad input" }));
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect((logger.warn as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe("tool:readFile failed");
    });

    it("includes resultStatus 'validation' in context", () => {
      toolContextLogger.error(makeEntry({ resultStatus: "validation" }));
      const ctx = (logger.warn as ReturnType<typeof mock>).mock.calls[0]?.[1] as Record<string, unknown>;
      expect(ctx["resultStatus"]).toBe("validation");
    });

    it("never calls error when resultStatus is 'validation'", () => {
      toolContextLogger.error(makeEntry({ resultStatus: "validation" }));
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  // --- ILogger.info is never called ---

  describe("ILogger.info", () => {
    it("is never called by ToolContextLogger", () => {
      toolContextLogger.info(makeEntry());
      toolContextLogger.error(makeEntry({ resultStatus: "runtime" }));
      toolContextLogger.error(makeEntry({ resultStatus: "permission" }));
      expect(logger.info).not.toHaveBeenCalled();
    });
  });
});
