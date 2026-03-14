import type { EmergencyStopSource, SafetySession } from "../../domain/safety/types";
import type { AuditEntry, IAuditLogger, IEmergencyStopHandler } from "./ports";

/**
 * EmergencyStopHandler implements IEmergencyStopHandler.
 *
 * Registers OS signal handlers for SIGINT and SIGTERM at agent session start.
 * On signal receipt or programmatic trigger:
 *   1. Sets session.emergencyStopRequested = true
 *   2. Writes a final audit entry with 'emergency-stop' outcome
 *   3. Waits for audit flush to complete
 *   4. Calls exitFn(1) to terminate the process
 *
 * The optional exitFn constructor parameter allows test environments to replace
 * process.exit without side effects.
 */
export class EmergencyStopHandler implements IEmergencyStopHandler {
  readonly #exitFn: (code: number) => never;
  #session: SafetySession | null = null;
  #auditLogger: IAuditLogger | null = null;
  #sigintHandler: (() => void) | null = null;
  #sigtermHandler: (() => void) | null = null;

  constructor(exitFn: (code: number) => never = process.exit) {
    this.#exitFn = exitFn;
  }

  register(session: SafetySession, auditLogger: IAuditLogger): void {
    this.#session = session;
    this.#auditLogger = auditLogger;

    this.#sigintHandler = () => {
      void this.trigger({ kind: "signal", signal: "SIGINT" });
    };
    this.#sigtermHandler = () => {
      void this.trigger({ kind: "signal", signal: "SIGTERM" });
    };

    process.on("SIGINT", this.#sigintHandler);
    process.on("SIGTERM", this.#sigtermHandler);
  }

  async trigger(source: EmergencyStopSource): Promise<void> {
    const session = this.#session;
    const auditLogger = this.#auditLogger;

    if (session && auditLogger) {
      session.emergencyStopRequested = true;
      session.emergencyStopSource = source;

      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        sessionId: session.sessionId,
        iterationNumber: session.iterationCount,
        toolName: "N/A",
        inputSummary: JSON.stringify(source).slice(0, 512),
        outcome: "emergency-stop",
        blockReason: `Emergency stop triggered: ${source.kind}`,
      };

      try {
        await auditLogger.write(entry);
        await auditLogger.flush();
      } catch {
        // Best-effort: do not let audit errors prevent process termination
      }
    }

    this.#exitFn(1);
  }

  deregister(): void {
    if (this.#sigintHandler) {
      process.removeListener("SIGINT", this.#sigintHandler);
      this.#sigintHandler = null;
    }
    if (this.#sigtermHandler) {
      process.removeListener("SIGTERM", this.#sigtermHandler);
      this.#sigtermHandler = null;
    }
    this.#session = null;
    this.#auditLogger = null;
  }
}
