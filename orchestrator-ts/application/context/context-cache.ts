import type { CachedEntry, CacheStats, IContextCache } from "../ports/context";

interface ContextCacheOptions {
	/** Maximum number of entries before LRU eviction. Default: 50. */
	capacity?: number;
}

/**
 * Session-scoped LRU cache for stable context layers (system instructions,
 * steering documents). I/O (fs.stat) is the responsibility of the caller;
 * this class only stores and retrieves pre-read entries.
 *
 * Layer restrictions (which layers may be cached) are enforced by the caller
 * (ContextEngineService) — CachedEntry has no layerId field.
 */
export class ContextCache implements IContextCache {
	private readonly capacity: number;
	/** Stores entries keyed by filePath. */
	private readonly store = new Map<string, CachedEntry>();
	/**
	 * Tracks access order for LRU eviction.
	 * Most-recently used is at the end; LRU is at the front.
	 */
	private readonly accessOrder: string[] = [];

	private hits = 0;
	private misses = 0;

	constructor(options: ContextCacheOptions = {}) {
		this.capacity = options.capacity ?? 50;
	}

	/**
	 * Return cached entry if filePath is present and mtime matches.
	 * Returns null and increments miss counter on staleness or absence.
	 */
	get(filePath: string, currentMtime: number): CachedEntry | null {
		const entry = this.store.get(filePath);
		if (!entry || entry.mtime !== currentMtime) {
			this.misses++;
			return null;
		}
		this.hits++;
		this.touch(filePath);
		return entry;
	}

	/**
	 * Store entry; evict the least-recently-used entry if at capacity.
	 */
	set(entry: CachedEntry): void {
		const { filePath } = entry;

		if (this.store.has(filePath)) {
			// Update in place — remove from access order so touch re-appends it.
			this.removeFromOrder(filePath);
		} else if (this.store.size >= this.capacity) {
			// Evict LRU (front of list).
			const lruKey = this.accessOrder.shift();
			if (lruKey !== undefined) {
				this.store.delete(lruKey);
			}
		}

		this.store.set(filePath, entry);
		this.accessOrder.push(filePath);
	}

	/** Remove the entry if present; no-op otherwise. */
	invalidate(filePath: string): void {
		if (this.store.has(filePath)) {
			this.store.delete(filePath);
			this.removeFromOrder(filePath);
		}
	}

	/** Return cumulative hit/miss/entry statistics. */
	stats(): CacheStats {
		return {
			hits: this.hits,
			misses: this.misses,
			entries: this.store.size,
		};
	}

	/** Remove all entries (called at session end). Does not reset counters. */
	clear(): void {
		this.store.clear();
		this.accessOrder.length = 0;
	}

	// -------------------------------------------------------------------------
	// Internal helpers
	// -------------------------------------------------------------------------

	private touch(filePath: string): void {
		this.removeFromOrder(filePath);
		this.accessOrder.push(filePath);
	}

	private removeFromOrder(filePath: string): void {
		const idx = this.accessOrder.indexOf(filePath);
		if (idx !== -1) {
			this.accessOrder.splice(idx, 1);
		}
	}
}
