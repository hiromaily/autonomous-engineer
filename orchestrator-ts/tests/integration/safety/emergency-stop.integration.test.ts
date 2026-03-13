/**
 * Integration tests for EmergencyStopHandler and AuditLogger durability.
 *
 * Uses the real AuditLogger (NDJSON file I/O) to verify that:
 * - SIGINT/programmatic triggers write durable audit entries to disk
 * - Concurrent AuditLogger.write() calls produce no interleaved JSON lines
 * - Log entries survive a simulated process restart (new AuditLogger instance)
 *
 * Task 9.2 — Requirements: 10.3, 12.1, 12.2, 12.3, 12.4, 12.5
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EmergencyStopHandler } from '../../../application/safety/emergency-stop-handler';
import { AuditLogger } from '../../../adapters/safety/audit-logger';
import { SafetyGuardedToolExecutor } from '../../../application/safety/guarded-executor';
import { createSafetyConfig, createSafetySession } from '../../../domain/safety/types';
import type { AuditEntry, IApprovalGateway, ISandboxExecutor } from '../../../application/safety/ports';
import type { IToolExecutor } from '../../../application/tools/executor';
import type { ToolContext, PermissionSet, ToolInvocationLog } from '../../../domain/tools/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePermissions(): PermissionSet {
  return Object.freeze({
    filesystemRead: true,
    filesystemWrite: true,
    shellExecution: true,
    gitWrite: true,
    networkAccess: true,
  });
}

function makeContext(workspaceRoot: string): ToolContext {
  return {
    workspaceRoot,
    workingDirectory: workspaceRoot,
    permissions: makePermissions(),
    memory: { search: async () => [] },
    logger: {
      info: mock((_entry: ToolInvocationLog) => {}),
      error: mock((_entry: ToolInvocationLog) => {}),
    },
  };
}

function makeInnerExecutor(): IToolExecutor {
  return { invoke: mock(async () => ({ ok: true as const, value: { result: 'ok' } })) };
}

function makeApprovalGateway(): IApprovalGateway {
  return { requestApproval: mock(async () => 'approved' as const) };
}

function makeSandboxExecutor(): ISandboxExecutor {
  return {
    execute: mock(async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1 })),
  };
}

function makeStubExitFn(): { exitCodes: number[]; fn: (code: number) => never } {
  const exitCodes: number[] = [];
  return {
    exitCodes,
    fn: (code: number) => { exitCodes.push(code); return undefined as unknown as never; },
  };
}

/** Parse all NDJSON lines from the audit log file. */
async function readAuditLog(logPath: string): Promise<AuditEntry[]> {
  const text = await readFile(logPath, 'utf-8');
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as AuditEntry);
}

/** Poll until predicate returns true or timeout expires. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 500,
  intervalMs: number = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('EmergencyStopHandler + AuditLogger — integration', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'emergency-stop-integration-'));
    logPath = join(tmpDir, 'audit.ndjson');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. SIGINT simulation
  // -------------------------------------------------------------------------

  describe('SIGINT simulation', () => {
    it('sets emergencyStopRequested, writes final audit entry, and rejects subsequent invoke() calls', async () => {
      const auditLogger = new AuditLogger(logPath);
      const session = createSafetySession();
      const config = createSafetyConfig({ workspaceRoot: tmpDir });
      const stub = makeStubExitFn();
      const handler = new EmergencyStopHandler(stub.fn);

      // Register handler
      handler.register(session, auditLogger);

      // Build executor so we can test subsequent rejection
      const executor = new SafetyGuardedToolExecutor(
        makeInnerExecutor(),
        session,
        config,
        auditLogger,
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );

      try {
        // Simulate OS signal
        process.emit('SIGINT');

        // Wait until the async trigger completes (exitFn is called after flush)
        await waitFor(() => stub.exitCodes.length > 0, 2000);

        // Session flag must be set
        expect(session.emergencyStopRequested).toBe(true);
        expect(session.emergencyStopSource).toEqual({ kind: 'signal', signal: 'SIGINT' });

        // Final audit entry must be in the log file
        await auditLogger.flush();
        const entries = await readAuditLog(logPath);
        expect(entries.length).toBeGreaterThanOrEqual(1);
        const stopEntry = entries.find(e => e.outcome === 'emergency-stop');
        expect(stopEntry).toBeDefined();
        expect(stopEntry!.sessionId).toBe(session.sessionId);
        expect(stopEntry!.toolName).toBe('N/A');

        // Subsequent invocations must be rejected immediately
        const result = await executor.invoke(
          'read_file',
          { path: join(tmpDir, 'foo.txt') },
          makeContext(tmpDir),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.type).toBe('runtime');
          expect(result.error.message).toContain('emergency stop');
        }
      } finally {
        handler.deregister();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Programmatic trigger — safety-violation
  // -------------------------------------------------------------------------

  describe('programmatic trigger (safety-violation)', () => {
    it('applies the same stop sequence and writes audit entry with correct emergencyStopSource', async () => {
      const auditLogger = new AuditLogger(logPath);
      const session = createSafetySession();
      const stub = makeStubExitFn();
      const handler = new EmergencyStopHandler(stub.fn);
      handler.register(session, auditLogger);

      const source = { kind: 'safety-violation' as const, description: 'shell blocklist matched' };

      await handler.trigger(source);

      // Session state
      expect(session.emergencyStopRequested).toBe(true);
      expect(session.emergencyStopSource).toEqual(source);

      // exitFn called with code 1
      expect(stub.exitCodes).toEqual([1]);

      // Audit entry on disk
      const entries = await readAuditLog(logPath);
      expect(entries.length).toBe(1);
      const entry = entries[0];
      expect(entry.outcome).toBe('emergency-stop');
      expect(entry.sessionId).toBe(session.sessionId);
      // Source kind encoded in inputSummary
      expect(entry.inputSummary).toContain('safety-violation');
      // blockReason references the trigger kind
      expect(entry.blockReason).toContain('safety-violation');

      handler.deregister();
    });
  });

  describe('programmatic trigger (resource-exhaustion)', () => {
    it('writes audit entry with resource-exhaustion source info', async () => {
      const auditLogger = new AuditLogger(logPath);
      const session = createSafetySession();
      const stub = makeStubExitFn();
      const handler = new EmergencyStopHandler(stub.fn);
      handler.register(session, auditLogger);

      const source = { kind: 'resource-exhaustion' as const, resource: 'disk' };
      await handler.trigger(source);

      const entries = await readAuditLog(logPath);
      expect(entries.length).toBe(1);
      expect(entries[0].outcome).toBe('emergency-stop');
      expect(entries[0].inputSummary).toContain('resource-exhaustion');

      handler.deregister();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Concurrent writes — no interleaved JSON lines
  // -------------------------------------------------------------------------

  describe('concurrent writes', () => {
    it('produces no interleaved partial JSON lines when multiple write() calls fire simultaneously', async () => {
      const auditLogger = new AuditLogger(logPath);
      const session = createSafetySession();
      const now = new Date().toISOString();

      const CONCURRENT = 20;

      // Fire all writes simultaneously — no await between them
      const promises = Array.from({ length: CONCURRENT }, (_, i) =>
        auditLogger.write({
          timestamp: now,
          sessionId: session.sessionId,
          iterationNumber: i,
          toolName: `tool_${i}`,
          inputSummary: JSON.stringify({ index: i }),
          outcome: 'success',
        }),
      );
      await Promise.all(promises);
      await auditLogger.flush();

      // Every line must be a valid, complete JSON object
      const text = await readFile(logPath, 'utf-8');
      const lines = text.split('\n').filter(l => l.trim().length > 0);

      expect(lines.length).toBe(CONCURRENT);

      for (const line of lines) {
        let parsed: AuditEntry | null = null;
        expect(() => { parsed = JSON.parse(line) as AuditEntry; }).not.toThrow();
        expect(parsed).not.toBeNull();
        expect((parsed as AuditEntry).sessionId).toBe(session.sessionId);
        expect((parsed as AuditEntry).outcome).toBe('success');
      }
    });

    it('all entries are parseable and contain the expected sessionId', async () => {
      const auditLogger = new AuditLogger(logPath);
      const session = createSafetySession();
      const now = new Date().toISOString();

      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          auditLogger.write({
            timestamp: now,
            sessionId: session.sessionId,
            iterationNumber: i,
            toolName: 'read_file',
            inputSummary: '{}',
            outcome: i % 2 === 0 ? 'success' : 'blocked',
          }),
        ),
      );
      await auditLogger.flush();

      const entries = await readAuditLog(logPath);
      expect(entries.length).toBe(10);
      for (const e of entries) {
        expect(e.sessionId).toBe(session.sessionId);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. Persistence — entries survive a new AuditLogger instance (process restart simulation)
  // -------------------------------------------------------------------------

  describe('persistence across AuditLogger instances', () => {
    it('preserves all previously written entries when a new logger instance appends to the same file', async () => {
      const session = createSafetySession();
      const now = new Date().toISOString();

      // Phase 1: first logger writes 3 entries
      const logger1 = new AuditLogger(logPath);
      for (let i = 0; i < 3; i++) {
        await logger1.write({
          timestamp: now,
          sessionId: session.sessionId,
          iterationNumber: i,
          toolName: `tool_phase1_${i}`,
          inputSummary: '{}',
          outcome: 'success',
        });
      }
      await logger1.flush();

      // Phase 2: second logger instance appends 2 more entries (simulates process restart)
      const logger2 = new AuditLogger(logPath);
      for (let i = 0; i < 2; i++) {
        await logger2.write({
          timestamp: now,
          sessionId: session.sessionId,
          iterationNumber: 3 + i,
          toolName: `tool_phase2_${i}`,
          inputSummary: '{}',
          outcome: 'success',
        });
      }
      await logger2.flush();

      // All 5 entries must be present and parseable
      const entries = await readAuditLog(logPath);
      expect(entries.length).toBe(5);

      const phase1Tools = entries.filter(e => e.toolName.startsWith('tool_phase1_'));
      const phase2Tools = entries.filter(e => e.toolName.startsWith('tool_phase2_'));
      expect(phase1Tools.length).toBe(3);
      expect(phase2Tools.length).toBe(2);
    });

    it('existing content is preserved and not overwritten on subsequent writes', async () => {
      const session = createSafetySession();
      const now = new Date().toISOString();

      const logger1 = new AuditLogger(logPath);
      await logger1.write({
        timestamp: now,
        sessionId: session.sessionId,
        iterationNumber: 0,
        toolName: 'original_tool',
        inputSummary: '{}',
        outcome: 'success',
      });
      await logger1.flush();

      // Verify entry written
      const beforeEntries = await readAuditLog(logPath);
      expect(beforeEntries.length).toBe(1);
      expect(beforeEntries[0].toolName).toBe('original_tool');

      // Second logger appends (does not overwrite)
      const logger2 = new AuditLogger(logPath);
      await logger2.write({
        timestamp: now,
        sessionId: session.sessionId,
        iterationNumber: 1,
        toolName: 'subsequent_tool',
        inputSummary: '{}',
        outcome: 'success',
      });
      await logger2.flush();

      const afterEntries = await readAuditLog(logPath);
      expect(afterEntries.length).toBe(2);
      // Original entry must still be intact
      expect(afterEntries[0].toolName).toBe('original_tool');
      expect(afterEntries[1].toolName).toBe('subsequent_tool');
    });
  });
});
