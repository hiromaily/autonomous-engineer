import { describe, it, expect } from 'bun:test';
import type {
  ISafetyGuard,
  SafetyCheckResult,
  SafetyContext,
  ApprovalRequest,
} from '../../../domain/safety/guards';
import {
  allowedResult,
  blockedResult,
  requiresApprovalResult,
} from '../../../domain/safety/guards';
import { createSafetyConfig, createSafetySession } from '../../../domain/safety/types';
import type { ToolContext, MemoryEntry } from '../../../domain/tools/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSafetyContext(): SafetyContext {
  const baseCtx: ToolContext = {
    workspaceRoot: '/workspace',
    workingDirectory: '/workspace',
    permissions: {
      filesystemRead: true,
      filesystemWrite: true,
      shellExecution: false,
      gitWrite: false,
      networkAccess: false,
    },
    memory: {
      async search(_query: string): Promise<ReadonlyArray<MemoryEntry>> {
        return [];
      },
    },
    logger: {
      info: () => {},
      error: () => {},
    },
  };

  const config = createSafetyConfig({ workspaceRoot: '/workspace' });
  const session = createSafetySession();

  return { ...baseCtx, session, config };
}

// ---------------------------------------------------------------------------
// SafetyCheckResult factory helpers
// ---------------------------------------------------------------------------

describe('allowedResult', () => {
  it('returns allowed: true with no error or approvalRequest', () => {
    const result = allowedResult();
    expect(result.allowed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.requiresApproval).toBeUndefined();
    expect(result.approvalRequest).toBeUndefined();
  });
});

describe('blockedResult', () => {
  it('returns allowed: false with a ToolError', () => {
    const result = blockedResult({ type: 'permission', message: 'access denied' });
    expect(result.allowed).toBe(false);
    expect(result.error?.type).toBe('permission');
    expect(result.error?.message).toBe('access denied');
    expect(result.requiresApproval).toBeUndefined();
  });
});

describe('requiresApprovalResult', () => {
  it('returns allowed: true with requiresApproval: true and a populated ApprovalRequest', () => {
    const request: ApprovalRequest = {
      description: 'Delete 15 files',
      riskClassification: 'high',
      expectedImpact: 'Permanent deletion of 15 source files',
      proposedAction: 'Proceed with bulk delete',
    };
    const result = requiresApprovalResult(request);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalRequest).toEqual(request);
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ApprovalRequest value object
// ---------------------------------------------------------------------------

describe('ApprovalRequest', () => {
  it('carries all required fields', () => {
    const req: ApprovalRequest = {
      description: 'Force-push to main',
      riskClassification: 'critical',
      expectedImpact: 'Overwrites remote history',
      proposedAction: 'git push --force origin main',
    };
    expect(req.description).toBe('Force-push to main');
    expect(req.riskClassification).toBe('critical');
    expect(req.expectedImpact).toBe('Overwrites remote history');
    expect(req.proposedAction).toBe('git push --force origin main');
  });
});

// ---------------------------------------------------------------------------
// SafetyContext extends ToolContext
// ---------------------------------------------------------------------------

describe('SafetyContext', () => {
  it('carries all ToolContext fields plus session and config', () => {
    const ctx = makeSafetyContext();
    // ToolContext fields
    expect(ctx.workspaceRoot).toBe('/workspace');
    expect(ctx.workingDirectory).toBe('/workspace');
    expect(ctx.permissions).toBeDefined();
    expect(ctx.memory).toBeDefined();
    expect(ctx.logger).toBeDefined();
    // Safety extensions
    expect(ctx.session).toBeDefined();
    expect(ctx.config).toBeDefined();
    expect(ctx.session.sessionId).toBeTruthy();
    expect(ctx.config.workspaceRoot).toBe('/workspace');
  });
});

// ---------------------------------------------------------------------------
// ISafetyGuard contract — structural compliance via duck-typing
// ---------------------------------------------------------------------------

describe('ISafetyGuard structural compliance', () => {
  it('a conforming guard resolves to an allowed result without throwing', async () => {
    const passGuard: ISafetyGuard = {
      name: 'pass-guard',
      check: async (_toolName, _rawInput, _ctx): Promise<SafetyCheckResult> => {
        return allowedResult();
      },
    };

    const ctx = makeSafetyContext();
    const result = await passGuard.check('read_file', { path: '/workspace/src/index.ts' }, ctx);
    expect(result.allowed).toBe(true);
  });

  it('a conforming guard resolves to a blocked result without throwing', async () => {
    const blockGuard: ISafetyGuard = {
      name: 'block-guard',
      check: async (_toolName, _rawInput, _ctx): Promise<SafetyCheckResult> => {
        return blockedResult({ type: 'permission', message: 'blocked by test guard' });
      },
    };

    const ctx = makeSafetyContext();
    const result = await blockGuard.check('write_file', { path: '/etc/passwd' }, ctx);
    expect(result.allowed).toBe(false);
    expect(result.error?.message).toBe('blocked by test guard');
  });

  it('a conforming guard resolves to a requiresApproval result without throwing', async () => {
    const approvalGuard: ISafetyGuard = {
      name: 'approval-guard',
      check: async (_toolName, _rawInput, _ctx): Promise<SafetyCheckResult> => {
        return requiresApprovalResult({
          description: 'Bulk delete',
          riskClassification: 'high',
          expectedImpact: 'Deletes 20 files',
          proposedAction: 'rm -rf build/',
        });
      },
    };

    const ctx = makeSafetyContext();
    const result = await approvalGuard.check('delete_files', { paths: [] }, ctx);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalRequest?.riskClassification).toBe('high');
  });

  it('guard has a non-empty name property', () => {
    const guard: ISafetyGuard = {
      name: 'my-guard',
      check: async () => allowedResult(),
    };
    expect(guard.name.length).toBeGreaterThan(0);
  });
});
