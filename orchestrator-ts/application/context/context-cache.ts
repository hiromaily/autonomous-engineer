import type { CachedEntry, CacheStats, IContextCache } from "../ports/context";

interface ContextCacheOptions {
	/** Maximum number of entries before LRU eviction. Default: 50. */
	capacity?: number;
}

// Doubly-linked list node for O(1) LRU tracking
interface LRUNode {
	key: string;
	prev: LRUNode | null;
	next: LRUNode | null;
}

/**
 * Session-scoped LRU cache for stable context layers (system instructions,
 * steering documents). I/O (fs.stat) is the responsibility of the caller;
 * this class only stores and retrieves pre-read entries.
 *
 * Layer restrictions (which layers may be cached) are enforced by the caller
 * (ContextEngineService) — CachedEntry has no layerId field.
 *
 * Uses a doubly-linked list + Map for O(1) get, set, and invalidate operations.
 */
export class ContextCache implements IContextCache {
	private readonly capacity: number;
	/** Stores entries keyed by filePath. */
	private readonly store = new Map<string, CachedEntry>();
	/** Map from filePath to its list node for O(1) node lookup. */
	private readonly nodeMap = new Map<string, LRUNode>();
	/** Sentinel head — next is the LRU (least recently used). */
	private readonly head: LRUNode = { key: "", prev: null, next: null };
	/** Sentinel tail — prev is the MRU (most recently used). */
	private readonly tail: LRUNode = { key: "", prev: null, next: null };

	private hits = 0;
	private misses = 0;

	constructor(options: ContextCacheOptions = {}) {
		this.capacity = options.capacity ?? 50;
		this.head.next = this.tail;
		this.tail.prev = this.head;
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
		this.moveToMRU(filePath);
		return entry;
	}

	/**
	 * Store entry; evict the least-recently-used entry if at capacity.
	 */
	set(entry: CachedEntry): void {
		const { filePath } = entry;

		if (this.store.has(filePath)) {
			// Update in place — move to MRU position.
			this.moveToMRU(filePath);
		} else {
			if (this.store.size >= this.capacity) {
				// Evict LRU (node after head sentinel).
				const lruNode = this.head.next;
				if (lruNode && lruNode !== this.tail) {
					this.removeNode(lruNode);
					this.nodeMap.delete(lruNode.key);
					this.store.delete(lruNode.key);
				}
			}
			// Insert new node before tail (MRU position).
			const node: LRUNode = { key: filePath, prev: null, next: null };
			this.insertBeforeTail(node);
			this.nodeMap.set(filePath, node);
		}

		this.store.set(filePath, entry);
	}

	/** Remove the entry if present; no-op otherwise. */
	invalidate(filePath: string): void {
		const node = this.nodeMap.get(filePath);
		if (node) {
			this.removeNode(node);
			this.nodeMap.delete(filePath);
			this.store.delete(filePath);
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
		this.nodeMap.clear();
		this.head.next = this.tail;
		this.tail.prev = this.head;
	}

	// -------------------------------------------------------------------------
	// Internal helpers
	// -------------------------------------------------------------------------

	/** Move an existing node to the MRU position (just before tail). */
	private moveToMRU(key: string): void {
		const node = this.nodeMap.get(key);
		if (node) {
			this.removeNode(node);
			this.insertBeforeTail(node);
		}
	}

	/** Detach a node from the list. */
	private removeNode(node: LRUNode): void {
		const prev = node.prev;
		const next = node.next;
		if (prev) prev.next = next;
		if (next) next.prev = prev;
		node.prev = null;
		node.next = null;
	}

	/** Insert a node just before the tail sentinel (MRU position). */
	private insertBeforeTail(node: LRUNode): void {
		const prev = this.tail.prev;
		node.prev = prev;
		node.next = this.tail;
		if (prev) prev.next = node;
		this.tail.prev = node;
	}
}
