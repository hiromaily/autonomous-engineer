import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EmergencyStopHandler } from "../../../application/safety/emergency-stop-handler";
import type { AuditEntry, IAuditLogger } from "../../../application/safety/ports";
import type { EmergencyStopSource } from "../../../domain/safety/types";
import { createSafetySession } from "../../../domain/safety/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeAuditLogger(): IAuditLogger & { entries: AuditEntry[]; flushed: number } {
  const entries: AuditEntry[] = [];
  let flushed = 0;
  return {
    entries,
    get flushed() {
      return flushed;
    },
    async write(entry: AuditEntry): Promise<void> {
      entries.push(entry);
    },
    async flush(): Promise<void> {
      flushed += 1;
    },
  };
}

// ---------------------------------------------------------------------------
// register() and deregister()
// ---------------------------------------------------------------------------

describe("EmergencyStopHandler.register()", () => {
  it("binds session and audit logger without throwing", () => {
    const session = createSafetySession();
    const logger = makeAuditLogger();
    const handler = new EmergencyStopHandler((_code) => undefined as unknown as never);

    expect(() => handler.register(session, logger)).not.toThrow();

    // clean up listeners so they do not interfere with other tests
    handler.deregister();
  });

  it("registers SIGINT and SIGTERM listeners on the process", () => {
    const session = createSafetySession();
    const logger = makeAuditLogger();
    const handler = new EmergencyStopHandler((_code) => undefined as unknown as never);

    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    handler.register(session, logger);

    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);

    handler.deregister();
  });
});

describe("EmergencyStopHandler.deregister()", () => {
  it("removes SIGINT and SIGTERM listeners", () => {
    const session = createSafetySession();
    const logger = makeAuditLogger();
    const handler = new EmergencyStopHandler((_code) => undefined as unknown as never);

    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    handler.register(session, logger);
    handler.deregister();

    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
  });

  it("is idempotent — calling deregister twice does not throw", () => {
    const session = createSafetySession();
    const logger = makeAuditLogger();
    const handler = new EmergencyStopHandler((_code) => undefined as unknown as never);

    handler.register(session, logger);
    expect(() => {
      handler.deregister();
      handler.deregister();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// trigger() — signal source
// ---------------------------------------------------------------------------

describe("EmergencyStopHandler.trigger() with signal source", () => {
  let session: ReturnType<typeof createSafetySession>;
  let logger: ReturnType<typeof makeAuditLogger>;
  let exitCodes: number[];
  let handler: EmergencyStopHandler;

  beforeEach(() => {
    session = createSafetySession();
    logger = makeAuditLogger();
    exitCodes = [];
    handler = new EmergencyStopHandler((code) => {
      exitCodes.push(code);
      return undefined as unknown as never;
    });
    handler.register(session, logger);
  });

  afterEach(() => {
    handler.deregister();
  });

  it("sets session.emergencyStopRequested = true", async () => {
    await handler.trigger({ kind: "signal", signal: "SIGINT" });
    expect(session.emergencyStopRequested).toBe(true);
  });

  it("sets session.emergencyStopSource to the given source", async () => {
    const source: EmergencyStopSource = { kind: "signal", signal: "SIGTERM" };
    await handler.trigger(source);
    expect(session.emergencyStopSource).toEqual(source);
  });

  it("writes an audit entry with emergency-stop outcome", async () => {
    await handler.trigger({ kind: "signal", signal: "SIGINT" });
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.outcome).toBe("emergency-stop");
  });

  it("includes sessionId and iterationNumber in the audit entry", async () => {
    session.iterationCount = 7;
    await handler.trigger({ kind: "signal", signal: "SIGINT" });
    const entry = logger.entries[0];
    if (!entry) throw new Error("expected audit entry");
    expect(entry.sessionId).toBe(session.sessionId);
    expect(entry.iterationNumber).toBe(7);
  });

  it("calls auditLogger.flush() after writing the entry", async () => {
    await handler.trigger({ kind: "signal", signal: "SIGINT" });
    expect(logger.flushed).toBeGreaterThanOrEqual(1);
  });

  it("calls exitFn(1) after flush", async () => {
    await handler.trigger({ kind: "signal", signal: "SIGINT" });
    expect(exitCodes).toEqual([1]);
  });

  it("writes an ISO 8601 timestamp in the audit entry", async () => {
    await handler.trigger({ kind: "signal", signal: "SIGINT" });
    const ts = logger.entries[0]?.timestamp;
    expect(ts).toBeDefined();
    expect(new Date(ts ?? "").toISOString()).toBe(ts);
  });
});

// ---------------------------------------------------------------------------
// trigger() — programmatic sources
// ---------------------------------------------------------------------------

describe("EmergencyStopHandler.trigger() with safety-violation source", () => {
  it("sets emergencyStopSource and writes audit entry", async () => {
    const session = createSafetySession();
    const logger = makeAuditLogger();
    const exitCodes: number[] = [];
    const handler = new EmergencyStopHandler((code) => {
      exitCodes.push(code);
      return undefined as unknown as never;
    });
    handler.register(session, logger);

    const source: EmergencyStopSource = { kind: "safety-violation", description: "shell command blocklist match" };
    await handler.trigger(source);

    expect(session.emergencyStopRequested).toBe(true);
    expect(session.emergencyStopSource).toEqual(source);
    expect(logger.entries[0]?.outcome).toBe("emergency-stop");
    expect(exitCodes).toEqual([1]);
    handler.deregister();
  });
});

describe("EmergencyStopHandler.trigger() with resource-exhaustion source", () => {
  it("sets emergencyStopSource and exits", async () => {
    const session = createSafetySession();
    const logger = makeAuditLogger();
    const exitCodes: number[] = [];
    const handler = new EmergencyStopHandler((code) => {
      exitCodes.push(code);
      return undefined as unknown as never;
    });
    handler.register(session, logger);

    const source: EmergencyStopSource = { kind: "resource-exhaustion", resource: "disk" };
    await handler.trigger(source);

    expect(session.emergencyStopRequested).toBe(true);
    expect(session.emergencyStopSource).toEqual(source);
    expect(logger.entries[0]?.outcome).toBe("emergency-stop");
    expect(exitCodes).toEqual([1]);
    handler.deregister();
  });
});

// ---------------------------------------------------------------------------
// SIGINT simulation
// ---------------------------------------------------------------------------

describe("EmergencyStopHandler — SIGINT signal simulation", () => {
  it("sets emergencyStopRequested when process receives SIGINT", async () => {
    const session = createSafetySession();
    const logger = makeAuditLogger();
    const exitCodes: number[] = [];
    const handler = new EmergencyStopHandler((code) => {
      exitCodes.push(code);
      return undefined as unknown as never;
    });
    handler.register(session, logger);

    // Simulate OS signal
    process.emit("SIGINT");

    // Signal handler is async — yield to the microtask queue
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(session.emergencyStopRequested).toBe(true);
    expect(session.emergencyStopSource).toEqual({ kind: "signal", signal: "SIGINT" });
    expect(logger.entries.length).toBeGreaterThanOrEqual(1);
    expect(exitCodes).toEqual([1]);

    handler.deregister();
  });
});

// ---------------------------------------------------------------------------
// trigger() without prior register()
// ---------------------------------------------------------------------------

describe("EmergencyStopHandler.trigger() without register()", () => {
  it("still calls exitFn(1) even when session is not set", async () => {
    const exitCodes: number[] = [];
    const handler = new EmergencyStopHandler((code) => {
      exitCodes.push(code);
      return undefined as unknown as never;
    });

    await handler.trigger({ kind: "signal", signal: "SIGINT" });

    expect(exitCodes).toEqual([1]);
  });
});
