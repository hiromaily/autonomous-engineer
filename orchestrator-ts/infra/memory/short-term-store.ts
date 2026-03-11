import type { ShortTermMemoryPort, ShortTermState } from '../../application/ports/memory';

/**
 * In-process, synchronous implementation of ShortTermMemoryPort.
 * Holds workflow context for a single run in process memory only — no file I/O.
 * Lifecycle is tied to one FileMemoryStore instance; RunSpecUseCase calls clear()
 * at the start of each new workflow run.
 */
export class InProcessShortTermStore implements ShortTermMemoryPort {
  private state: ShortTermState = { recentFiles: [] };

  /** Return current ephemeral state (never throws). */
  read(): ShortTermState {
    return this.state;
  }

  /** Merge update into current state (partial update semantics). */
  write(update: Partial<ShortTermState>): void {
    this.state = { ...this.state, ...update };
  }

  /** Reset all state to initial empty values. */
  clear(): void {
    this.state = { recentFiles: [] };
  }
}
