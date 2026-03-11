import { readFile, open, mkdir, rename, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type {
  MemoryPort,
  ShortTermMemoryPort,
  MemoryTarget,
  MemoryEntry,
  MemoryQuery,
  MemoryQueryResult,
  MemoryWriteResult,
  MemoryWriteTrigger,
  FailureRecord,
  FailureFilter,
  ProjectMemoryFile,
  KnowledgeMemoryFile,
  RankedMemoryEntry,
} from '../../application/ports/memory';
import { InProcessShortTermStore } from './short-term-store';

// ---------------------------------------------------------------------------
// Public options type
// ---------------------------------------------------------------------------

export interface FileMemoryStoreOptions {
  readonly baseDir?: string;
}

// ---------------------------------------------------------------------------
// Constants: all memory file names
// ---------------------------------------------------------------------------

const PROJECT_FILES: readonly ProjectMemoryFile[] = [
  'project_rules',
  'coding_patterns',
  'review_feedback',
  'architecture_notes',
];

const KNOWLEDGE_FILES: readonly KnowledgeMemoryFile[] = [
  'coding_rules',
  'review_rules',
  'implementation_patterns',
  'debugging_patterns',
];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

// ---------------------------------------------------------------------------
// FileMemoryStore
// ---------------------------------------------------------------------------

/**
 * File-based implementation of MemoryPort.
 * - Project memory: {baseDir}/.memory/{file}.md
 * - Knowledge memory: {baseDir}/rules/{file}.md
 * - Failure records: {baseDir}/.memory/failures/failure_{ts}_{taskId}.json
 *
 * All file writes use atomic temp-file + rename (implemented in tasks 3.2–3.4).
 */
export class FileMemoryStore implements MemoryPort {
  readonly shortTerm: ShortTermMemoryPort;
  private readonly baseDir: string;

  constructor(options?: FileMemoryStoreOptions) {
    this.baseDir = options?.baseDir ?? process.cwd();
    this.shortTerm = new InProcessShortTermStore();
  }

  // -------------------------------------------------------------------------
  // Path resolution
  // -------------------------------------------------------------------------

  private resolveProjectPath(file: ProjectMemoryFile): string {
    return join(this.baseDir, '.memory', `${file}.md`);
  }

  private resolveKnowledgePath(file: KnowledgeMemoryFile): string {
    return join(this.baseDir, 'rules', `${file}.md`);
  }

  /** Map a MemoryTarget discriminated union to a concrete file path. */
  private resolveTargetPath(target: MemoryTarget): string {
    if (target.type === 'project') {
      return this.resolveProjectPath(target.file);
    }
    return this.resolveKnowledgePath(target.file);
  }

  // -------------------------------------------------------------------------
  // File I/O helpers
  // -------------------------------------------------------------------------

  /** Read a file, returning an empty string if the file does not exist. */
  private async readFileSafe(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, 'utf-8');
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return '';
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Markdown formatting (task 3.1)
  // -------------------------------------------------------------------------

  /**
   * Format a single MemoryEntry as a Markdown section.
   *
   * Output format:
   * ```
   * ## {title}
   *
   * - **Date**: {date}
   * - **Context**: {context}
   *
   * {description}
   * ```
   */
  formatEntry(entry: MemoryEntry): string {
    return [
      `## ${entry.title}`,
      '',
      `- **Date**: ${entry.date}`,
      `- **Context**: ${entry.context}`,
      '',
      entry.description,
      '',
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // Markdown parsing (task 3.1)
  // -------------------------------------------------------------------------

  /**
   * Parse Markdown file content into an array of MemoryEntry objects.
   *
   * Splits on level-2 headings (`## `). Each section is parsed for:
   * - title: the text after `## `
   * - date: from `- **Date**: {value}`
   * - context: from `- **Context**: {value}`
   * - description: all remaining lines after the metadata block, trimmed
   *
   * Returns an empty array when the content is empty or has no `## ` headings.
   * Never throws.
   */
  parseEntries(content: string): MemoryEntry[] {
    if (!content.trim()) return [];

    // Split on level-2 headings at the start of a line (lookahead preserves the delimiter)
    const rawSections = content.split(/(?=^## )/m);
    const entries: MemoryEntry[] = [];

    for (const raw of rawSections) {
      const section = raw.trim();
      if (!section.startsWith('## ')) continue;

      const lines = section.split('\n');
      const titleLine = lines[0] ?? '';
      const title = titleLine.replace(/^## /, '').trim();
      if (!title) continue;

      let date = '';
      let context = '';
      const descLines: string[] = [];
      let pastMeta = false;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i] ?? '';

        if (line.startsWith('- **Date**: ')) {
          date = line.replace('- **Date**: ', '').trim();
        } else if (line.startsWith('- **Context**: ')) {
          context = line.replace('- **Context**: ', '').trim();
          pastMeta = true;
        } else if (line === '---') {
          // Entry separator — stop parsing this section
          break;
        } else if (pastMeta) {
          descLines.push(line);
        }
        // else: empty/other line before metadata — skip
      }

      const description = descLines.join('\n').trim();

      if (title && date) {
        entries.push({ title, context, description, date });
      }
    }

    return entries;
  }

  // -------------------------------------------------------------------------
  // query() — keyword-based retrieval with relevance scoring (task 3.1 / 3.5)
  // -------------------------------------------------------------------------

  async query(query: MemoryQuery): Promise<MemoryQueryResult> {
    const memoryTypes = query.memoryTypes ?? ['project', 'knowledge'];
    const topN = query.topN ?? 5;
    const allCandidates: RankedMemoryEntry[] = [];

    if (memoryTypes.includes('project')) {
      for (const file of PROJECT_FILES) {
        const content = await this.readFileSafe(this.resolveProjectPath(file));
        for (const entry of this.parseEntries(content)) {
          allCandidates.push({ entry, sourceFile: file, relevanceScore: 0 });
        }
      }
    }

    if (memoryTypes.includes('knowledge')) {
      for (const file of KNOWLEDGE_FILES) {
        const content = await this.readFileSafe(this.resolveKnowledgePath(file));
        for (const entry of this.parseEntries(content)) {
          allCandidates.push({ entry, sourceFile: file, relevanceScore: 0 });
        }
      }
    }

    // Tokenize query text and pre-compile regexes once (reused across all candidates)
    const tokens = query.text
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 0);
    const tokenRegexes = tokens.map(t => new RegExp(t, 'g'));

    // Score each candidate by token occurrence count in title + description + context
    const scored = allCandidates.map(candidate => {
      if (tokenRegexes.length === 0) return candidate;
      const haystack =
        `${candidate.entry.title} ${candidate.entry.description} ${candidate.entry.context}`.toLowerCase();
      const score = tokenRegexes.reduce((acc, regex) => {
        const matches = (haystack.match(regex) ?? []).length;
        return acc + matches;
      }, 0);
      return { ...candidate, relevanceScore: score };
    });

    // When query has tokens, keep only entries with at least one match
    const filtered =
      tokens.length > 0 ? scored.filter(c => c.relevanceScore > 0) : scored;

    // Sort descending by score and apply topN limit
    const top = filtered
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, topN);

    // Normalize relevance scores to 0.0–1.0
    const maxScore = Math.max(...top.map(c => c.relevanceScore), 1);
    const normalized = top.map(c => ({
      ...c,
      relevanceScore: c.relevanceScore / maxScore,
    }));

    return { entries: normalized };
  }

  // -------------------------------------------------------------------------
  // Atomic file write helper
  // -------------------------------------------------------------------------

  /**
   * Write `content` to `destPath` atomically using a sibling `.tmp` file.
   * Ensures the parent directory exists before writing.
   */
  private async atomicWrite(destPath: string, content: string): Promise<void> {
    const dir = dirname(destPath);
    await mkdir(dir, { recursive: true });

    const tmpPath = `${destPath}.tmp`;
    const fd = await open(tmpPath, 'w');
    try {
      await fd.write(content);
      await fd.datasync();
    } finally {
      await fd.close();
    }
    await rename(tmpPath, destPath);
  }

  // -------------------------------------------------------------------------
  // append() — task 3.2
  // -------------------------------------------------------------------------

  async append(
    target: MemoryTarget,
    entry: MemoryEntry,
    _trigger: MemoryWriteTrigger,
  ): Promise<MemoryWriteResult> {
    // Validate: title must be non-empty
    if (!entry.title.trim()) {
      return {
        ok: false,
        error: { category: 'invalid_entry', message: 'entry title must not be blank' },
      };
    }

    const targetPath = this.resolveTargetPath(target);
    const existing = await this.readFileSafe(targetPath);
    const existingEntries = this.parseEntries(existing);

    // Deduplication: case-insensitive title match
    const titleLower = entry.title.toLowerCase();
    if (existingEntries.some(e => e.title.toLowerCase() === titleLower)) {
      return { ok: true, action: 'skipped_duplicate' };
    }

    // Format new entry and build updated file content
    const newEntryMd = this.formatEntry(entry);
    const updated = existing.trim()
      ? `${existing.trimEnd()}\n\n---\n\n${newEntryMd}`
      : newEntryMd;

    await this.atomicWrite(targetPath, updated);
    return { ok: true, action: 'appended' };
  }

  // -------------------------------------------------------------------------
  // update() — task 3.3
  // -------------------------------------------------------------------------

  async update(
    target: MemoryTarget,
    entryTitle: string,
    entry: MemoryEntry,
  ): Promise<MemoryWriteResult> {
    const targetPath = this.resolveTargetPath(target);
    const existing = await this.readFileSafe(targetPath);
    const entries = this.parseEntries(existing);

    // Find entry by title (case-insensitive)
    const titleLower = entryTitle.toLowerCase();
    const idx = entries.findIndex(e => e.title.toLowerCase() === titleLower);
    if (idx === -1) {
      return {
        ok: false,
        error: { category: 'not_found', message: `entry not found: "${entryTitle}"` },
      };
    }

    // Replace matched entry, preserving all others and their order
    const updated = entries.map((e, i) => (i === idx ? entry : e));

    // Serialize all entries back to Markdown, separated by ---
    const content = updated.map(e => this.formatEntry(e)).join('\n---\n\n');
    await this.atomicWrite(targetPath, content);
    return { ok: true, action: 'updated' };
  }

  // -------------------------------------------------------------------------
  // writeFailure() — task 3.4
  // -------------------------------------------------------------------------

  async writeFailure(record: FailureRecord): Promise<MemoryWriteResult> {
    // Sanitize timestamp for use in filename: ISO 8601 timestamps contain ':'
    // characters (e.g. "2026-03-11T09:12:15Z") which are illegal in filenames
    // on Windows and some other filesystems, so replace them with '-'.
    const safeTs = record.timestamp.replace(/:/g, '-');
    const filename = `failure_${safeTs}_${record.taskId}.json`;
    const failuresDir = join(this.baseDir, '.memory', 'failures');
    const destPath = join(failuresDir, filename);

    try {
      await mkdir(failuresDir, { recursive: true });

      const content = JSON.stringify(record, null, 2);
      const tmpPath = `${destPath}.tmp`;
      const fd = await open(tmpPath, 'w');
      try {
        await fd.write(content);
        await fd.datasync();
      } finally {
        await fd.close();
      }
      await rename(tmpPath, destPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { category: 'io_error', message } };
    }

    return { ok: true, action: 'appended' };
  }

  // -------------------------------------------------------------------------
  // getFailures() — task 3.4
  // -------------------------------------------------------------------------

  async getFailures(filter?: FailureFilter): Promise<readonly FailureRecord[]> {
    const failuresDir = join(this.baseDir, '.memory', 'failures');

    let filenames: string[];
    try {
      filenames = await readdir(failuresDir);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return [];
      throw err;
    }

    const records: FailureRecord[] = [];
    for (const filename of filenames) {
      if (!filename.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(failuresDir, filename), 'utf-8');
        records.push(JSON.parse(raw) as FailureRecord);
      } catch {
        // Skip unparseable files
      }
    }

    // Apply in-memory filters
    return records.filter(r => {
      if (filter?.specName !== undefined && r.specName !== filter.specName) return false;
      if (filter?.taskId !== undefined && r.taskId !== filter.taskId) return false;
      return true;
    });
  }
}
