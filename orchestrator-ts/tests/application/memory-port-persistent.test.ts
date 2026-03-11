import { describe, it, expect } from 'bun:test';
import type {
  ProjectMemoryFile,
  KnowledgeMemoryFile,
  MemoryLayerType,
  MemoryTarget,
  MemoryEntry,
  MemoryWriteTrigger,
  MemoryQuery,
  RankedMemoryEntry,
  MemoryQueryResult,
  FailureRecord,
  FailureFilter,
  MemoryPort,
  ShortTermMemoryPort,
  ShortTermState,
  MemoryWriteResult,
  MemoryErrorCategory,
} from '../../application/ports/memory';

// ---------------------------------------------------------------------------
// MemoryTarget discriminated union
// ---------------------------------------------------------------------------

describe('MemoryTarget discriminated union', () => {
  it('project target narrows to ProjectMemoryFile', () => {
    const target: MemoryTarget = { type: 'project', file: 'project_rules' };
    if (target.type === 'project') {
      expect(target.file).toBe('project_rules');
    }
  });

  it('knowledge target narrows to KnowledgeMemoryFile', () => {
    const target: MemoryTarget = { type: 'knowledge', file: 'coding_rules' };
    if (target.type === 'knowledge') {
      expect(target.file).toBe('coding_rules');
    }
  });

  it('ProjectMemoryFile includes exactly four values', () => {
    const files: ProjectMemoryFile[] = [
      'project_rules',
      'coding_patterns',
      'review_feedback',
      'architecture_notes',
    ];
    expect(files).toHaveLength(4);
  });

  it('KnowledgeMemoryFile includes exactly four values', () => {
    const files: KnowledgeMemoryFile[] = [
      'coding_rules',
      'review_rules',
      'implementation_patterns',
      'debugging_patterns',
    ];
    expect(files).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// MemoryEntry
// ---------------------------------------------------------------------------

describe('MemoryEntry', () => {
  it('requires title, context, description, and date', () => {
    const entry: MemoryEntry = {
      title: 'Use atomic writes',
      context: 'infra/memory',
      description: 'Always write to a .tmp file and rename to prevent partial writes.',
      date: '2026-03-11T06:00:00Z',
    };

    expect(entry.title).toBe('Use atomic writes');
    expect(entry.context).toBe('infra/memory');
    expect(entry.description).toContain('rename');
    expect(entry.date).toBe('2026-03-11T06:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// MemoryWriteTrigger
// ---------------------------------------------------------------------------

describe('MemoryWriteTrigger', () => {
  it('includes exactly four trigger values', () => {
    const triggers: MemoryWriteTrigger[] = [
      'implementation_pattern',
      'review_feedback',
      'debugging_discovery',
      'self_healing',
    ];
    expect(triggers).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// MemoryQuery and MemoryQueryResult
// ---------------------------------------------------------------------------

describe('MemoryQuery', () => {
  it('requires text; memoryTypes and topN are optional', () => {
    const minimal: MemoryQuery = { text: 'atomic write' };
    expect(minimal.text).toBe('atomic write');
    expect(minimal.memoryTypes).toBeUndefined();
    expect(minimal.topN).toBeUndefined();
  });

  it('accepts type filter and topN limit', () => {
    const query: MemoryQuery = {
      text: 'coding pattern',
      memoryTypes: ['project', 'knowledge'],
      topN: 10,
    };
    expect(query.memoryTypes).toHaveLength(2);
    expect(query.topN).toBe(10);
  });
});

describe('RankedMemoryEntry', () => {
  it('holds entry, sourceFile, and relevanceScore', () => {
    const entry: MemoryEntry = {
      title: 'Pattern A',
      context: 'ctx',
      description: 'desc',
      date: '2026-01-01T00:00:00Z',
    };
    const ranked: RankedMemoryEntry = {
      entry,
      sourceFile: 'coding_patterns',
      relevanceScore: 0.85,
    };

    expect(ranked.entry.title).toBe('Pattern A');
    expect(ranked.sourceFile).toBe('coding_patterns');
    expect(ranked.relevanceScore).toBe(0.85);
  });
});

describe('MemoryQueryResult', () => {
  it('holds readonly array of ranked entries', () => {
    const result: MemoryQueryResult = { entries: [] };
    expect(result.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FailureRecord and FailureFilter
// ---------------------------------------------------------------------------

describe('FailureRecord', () => {
  it('holds all required fields including optional ruleUpdate', () => {
    const record: FailureRecord = {
      taskId: 'task-3.2',
      specName: 'memory-system',
      phase: 'IMPLEMENTATION',
      attempted: 'Atomic write to .memory/project_rules.md',
      errors: ['ENOENT: no such file or directory'],
      rootCause: 'Directory was not created before write',
      timestamp: '2026-03-11T07:00:00Z',
    };

    expect(record.taskId).toBe('task-3.2');
    expect(record.specName).toBe('memory-system');
    expect(record.errors).toHaveLength(1);
    expect(record.ruleUpdate).toBeUndefined();
  });

  it('accepts optional ruleUpdate when provided', () => {
    const record: FailureRecord = {
      taskId: 'task-4.1',
      specName: 'tool-system',
      phase: 'IMPLEMENTATION',
      attempted: 'Some operation',
      errors: ['Error detail'],
      rootCause: 'Root cause',
      ruleUpdate: 'Always create directory before writing',
      timestamp: '2026-03-11T07:30:00Z',
    };

    expect(record.ruleUpdate).toBe('Always create directory before writing');
  });
});

describe('FailureFilter', () => {
  it('is fully optional', () => {
    const empty: FailureFilter = {};
    expect(empty.specName).toBeUndefined();
    expect(empty.taskId).toBeUndefined();
  });

  it('accepts specName and taskId filters', () => {
    const filter: FailureFilter = { specName: 'memory-system', taskId: 'task-3.2' };
    expect(filter.specName).toBe('memory-system');
    expect(filter.taskId).toBe('task-3.2');
  });
});

// ---------------------------------------------------------------------------
// MemoryErrorCategory
// ---------------------------------------------------------------------------

describe('MemoryErrorCategory', () => {
  it('includes io_error, invalid_entry, not_found', () => {
    const categories: MemoryErrorCategory[] = [
      'io_error',
      'invalid_entry',
      'not_found',
    ];
    expect(categories).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// MemoryLayerType
// ---------------------------------------------------------------------------

describe('MemoryLayerType', () => {
  it('is the shared discriminant for MemoryTarget and MemoryQuery.memoryTypes', () => {
    const layers: MemoryLayerType[] = ['project', 'knowledge'];
    expect(layers).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// MemoryWriteResult discriminated union
// ---------------------------------------------------------------------------

describe('MemoryWriteResult discriminated union', () => {
  it('narrows to action on ok: true', () => {
    const result: MemoryWriteResult = { ok: true, action: 'appended' };
    if (result.ok) {
      expect(result.action).toBe('appended');
    }
  });

  it('narrows to error on ok: false', () => {
    const result: MemoryWriteResult = {
      ok: false,
      error: { category: 'invalid_entry', message: 'Title is empty' },
    };
    if (!result.ok) {
      expect(result.error.category).toBe('invalid_entry');
      expect(result.error.message).toBe('Title is empty');
    }
  });

  it('supports skipped_duplicate action', () => {
    const result: MemoryWriteResult = { ok: true, action: 'skipped_duplicate' };
    if (result.ok) {
      expect(result.action).toBe('skipped_duplicate');
    }
  });
});

// ---------------------------------------------------------------------------
// MemoryPort contract via mock implementation
// ---------------------------------------------------------------------------

function makeShortTermStore(): ShortTermMemoryPort {
  let state: ShortTermState = { recentFiles: [] };
  return {
    read: () => state,
    write: (update: Partial<ShortTermState>) => { state = { ...state, ...update }; },
    clear: () => { state = { recentFiles: [] }; },
  };
}

function makeMemoryPort(): MemoryPort {
  const shortTerm = makeShortTermStore();
  const entries: Array<{ target: MemoryTarget; entry: MemoryEntry }> = [];
  const failures: FailureRecord[] = [];

  return {
    shortTerm,

    async query(q: MemoryQuery): Promise<MemoryQueryResult> {
      const tokens = q.text.toLowerCase().split(/\s+/);
      const scored = entries.map(({ entry, target }) => {
        const text = `${entry.title} ${entry.description}`.toLowerCase();
        const score = tokens.reduce((n: number, t: string) => n + (text.includes(t) ? 1 : 0), 0);
        return { entry, sourceFile: target.file, relevanceScore: score / tokens.length };
      });
      const topN = q.topN ?? 5;
      return {
        entries: scored
          .filter(r => r.relevanceScore > 0)
          .sort((a, b) => b.relevanceScore - a.relevanceScore)
          .slice(0, topN),
      };
    },

    async append(target: MemoryTarget, entry: MemoryEntry): Promise<MemoryWriteResult> {
      if (!entry.title.trim()) {
        return { ok: false, error: { category: 'invalid_entry', message: 'Title is empty' } };
      }
      const dup = entries.some(
        e => e.entry.title.toLowerCase() === entry.title.toLowerCase() &&
          e.target.type === target.type && e.target.file === target.file,
      );
      if (dup) return { ok: true, action: 'skipped_duplicate' };
      entries.push({ target, entry });
      return { ok: true, action: 'appended' };
    },

    async update(target: MemoryTarget, entryTitle: string, entry: MemoryEntry): Promise<MemoryWriteResult> {
      const idx = entries.findIndex(
        e => e.entry.title.toLowerCase() === entryTitle.toLowerCase() &&
          e.target.type === target.type && e.target.file === target.file,
      );
      if (idx === -1) {
        return { ok: false, error: { category: 'not_found', message: `Entry not found: ${entryTitle}` } };
      }
      entries[idx] = { target, entry };
      return { ok: true, action: 'updated' };
    },

    async writeFailure(record: FailureRecord): Promise<MemoryWriteResult> {
      failures.push(record);
      return { ok: true, action: 'appended' };
    },

    async getFailures(filter?: FailureFilter): Promise<readonly FailureRecord[]> {
      return failures.filter(r =>
        (!filter?.specName || r.specName === filter.specName) &&
        (!filter?.taskId || r.taskId === filter.taskId),
      );
    },
  };
}

describe('MemoryPort contract (mock implementation)', () => {
  it('shortTerm property satisfies ShortTermMemoryPort', () => {
    const port = makeMemoryPort();
    port.shortTerm.write({ currentSpec: 'memory-system' });
    expect(port.shortTerm.read().currentSpec).toBe('memory-system');
  });

  it('append() returns appended on new entry', async () => {
    const port = makeMemoryPort();
    const entry: MemoryEntry = {
      title: 'New Pattern',
      context: 'ctx',
      description: 'desc',
      date: '2026-03-11T00:00:00Z',
    };
    const result = await port.append({ type: 'project', file: 'coding_patterns' }, entry, 'implementation_pattern');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe('appended');
  });

  it('append() returns skipped_duplicate on same title (case-insensitive)', async () => {
    const port = makeMemoryPort();
    const entry: MemoryEntry = { title: 'Duplicate Title', context: 'ctx', description: 'desc', date: '2026-01-01T00:00:00Z' };
    const target: MemoryTarget = { type: 'project', file: 'project_rules' };
    await port.append(target, entry, 'review_feedback');
    const second = await port.append(target, { ...entry, title: 'duplicate title' }, 'review_feedback');
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.action).toBe('skipped_duplicate');
  });

  it('append() returns invalid_entry error on blank title', async () => {
    const port = makeMemoryPort();
    const entry: MemoryEntry = { title: '', context: 'ctx', description: 'desc', date: '2026-01-01T00:00:00Z' };
    const result = await port.append({ type: 'project', file: 'project_rules' }, entry, 'implementation_pattern');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe('invalid_entry');
  });

  it('update() replaces entry and returns updated', async () => {
    const port = makeMemoryPort();
    const target: MemoryTarget = { type: 'knowledge', file: 'coding_rules' };
    const original: MemoryEntry = { title: 'Old Rule', context: 'ctx', description: 'old', date: '2026-01-01T00:00:00Z' };
    await port.append(target, original, 'self_healing');
    const updated: MemoryEntry = { ...original, description: 'updated description' };
    const result = await port.update(target, 'Old Rule', updated);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe('updated');
  });

  it('update() returns not_found when title does not exist', async () => {
    const port = makeMemoryPort();
    const entry: MemoryEntry = { title: 'Ghost', context: 'ctx', description: 'desc', date: '2026-01-01T00:00:00Z' };
    const result = await port.update({ type: 'knowledge', file: 'coding_rules' }, 'Ghost', entry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe('not_found');
  });

  it('writeFailure() stores record retrievable by getFailures()', async () => {
    const port = makeMemoryPort();
    const record: FailureRecord = {
      taskId: 'task-1',
      specName: 'spec-a',
      phase: 'IMPLEMENTATION',
      attempted: 'op',
      errors: ['err'],
      rootCause: 'cause',
      timestamp: '2026-03-11T00:00:00Z',
    };
    await port.writeFailure(record);
    const results = await port.getFailures({ specName: 'spec-a' });
    expect(results).toHaveLength(1);
    expect(results[0]?.taskId).toBe('task-1');
  });

  it('getFailures() returns empty list when no records match filter', async () => {
    const port = makeMemoryPort();
    const results = await port.getFailures({ specName: 'nonexistent' });
    expect(results).toHaveLength(0);
  });

  it('query() returns ranked results for matching keywords', async () => {
    const port = makeMemoryPort();
    const target: MemoryTarget = { type: 'project', file: 'coding_patterns' };
    await port.append(target, { title: 'Atomic Write Pattern', context: 'ctx', description: 'Use temp file then rename', date: '2026-01-01T00:00:00Z' }, 'implementation_pattern');
    await port.append(target, { title: 'Unrelated Entry', context: 'ctx', description: 'Something else', date: '2026-01-01T00:00:00Z' }, 'implementation_pattern');
    const result = await port.query({ text: 'atomic write' });
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0]?.entry.title).toBe('Atomic Write Pattern');
  });

  it('query() respects topN limit', async () => {
    const port = makeMemoryPort();
    const target: MemoryTarget = { type: 'project', file: 'coding_patterns' };
    for (let i = 0; i < 10; i++) {
      await port.append(target, { title: `Pattern ${i}`, context: 'ctx', description: 'pattern code here', date: '2026-01-01T00:00:00Z' }, 'implementation_pattern');
    }
    const result = await port.query({ text: 'pattern', topN: 3 });
    expect(result.entries.length).toBeLessThanOrEqual(3);
  });
});
