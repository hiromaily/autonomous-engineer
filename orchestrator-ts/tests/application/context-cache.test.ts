import { describe, expect, it } from "bun:test";
import { ContextCache } from "../../application/context/context-cache";
import type { CachedEntry } from "../../application/ports/context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
	filePath: string,
	mtime: number,
	overrides: Partial<CachedEntry> = {},
): CachedEntry {
	return {
		filePath,
		content: `content of ${filePath}`,
		tokenCount: 10,
		mtime,
		cachedAt: new Date().toISOString(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContextCache", () => {
	describe("get()", () => {
		it("returns the cached entry when mtime matches", () => {
			const cache = new ContextCache();
			const entry = makeEntry("file.ts", 1000);
			cache.set(entry);

			const result = cache.get("file.ts", 1000);
			expect(result).toEqual(entry);
		});

		it("returns null when mtime differs (stale)", () => {
			const cache = new ContextCache();
			const entry = makeEntry("file.ts", 1000);
			cache.set(entry);

			const result = cache.get("file.ts", 2000);
			expect(result).toBeNull();
		});

		it("returns null when file is not cached (miss)", () => {
			const cache = new ContextCache();

			const result = cache.get("nonexistent.ts", 1000);
			expect(result).toBeNull();
		});

		it("increments miss counter on cache miss", () => {
			const cache = new ContextCache();
			cache.get("missing.ts", 1000);

			expect(cache.stats().misses).toBe(1);
		});

		it("increments miss counter on stale entry", () => {
			const cache = new ContextCache();
			const entry = makeEntry("file.ts", 1000);
			cache.set(entry);
			cache.get("file.ts", 9999);

			expect(cache.stats().misses).toBe(1);
		});

		it("increments hit counter on cache hit", () => {
			const cache = new ContextCache();
			const entry = makeEntry("file.ts", 1000);
			cache.set(entry);
			cache.get("file.ts", 1000);

			expect(cache.stats().hits).toBe(1);
		});
	});

	describe("set()", () => {
		it("stores an entry retrievable by filePath", () => {
			const cache = new ContextCache();
			const entry = makeEntry("a.ts", 500);
			cache.set(entry);

			expect(cache.get("a.ts", 500)).toEqual(entry);
		});

		it("overwrites an existing entry for the same filePath", () => {
			const cache = new ContextCache();
			const first = makeEntry("a.ts", 500, { content: "old" });
			const second = makeEntry("a.ts", 600, { content: "new" });
			cache.set(first);
			cache.set(second);

			// old mtime is stale
			expect(cache.get("a.ts", 500)).toBeNull();
			// new mtime returns new entry
			expect(cache.get("a.ts", 600)?.content).toBe("new");
		});

		it("evicts the LRU entry when capacity is reached (default 50)", () => {
			const cache = new ContextCache(); // default capacity = 50

			// fill to capacity
			for (let i = 0; i < 50; i++) {
				cache.set(makeEntry(`file${i}.ts`, 1000));
			}

			// access file0 to make it recently used
			cache.get("file0.ts", 1000);

			// the 51st insert should evict the LRU entry (file1.ts is now oldest)
			cache.set(makeEntry("file50.ts", 1000));

			expect(cache.get("file1.ts", 1000)).toBeNull(); // evicted
			expect(cache.get("file0.ts", 1000)).not.toBeNull(); // recently used — kept
			expect(cache.get("file50.ts", 1000)).not.toBeNull(); // just inserted
		});

		it("counts entries correctly", () => {
			const cache = new ContextCache();
			cache.set(makeEntry("a.ts", 1));
			cache.set(makeEntry("b.ts", 2));

			expect(cache.stats().entries).toBe(2);
		});
	});

	describe("invalidate()", () => {
		it("removes the specific entry", () => {
			const cache = new ContextCache();
			cache.set(makeEntry("a.ts", 1));
			cache.invalidate("a.ts");

			expect(cache.get("a.ts", 1)).toBeNull();
		});

		it("does not affect other entries", () => {
			const cache = new ContextCache();
			cache.set(makeEntry("a.ts", 1));
			cache.set(makeEntry("b.ts", 2));
			cache.invalidate("a.ts");

			expect(cache.get("b.ts", 2)).not.toBeNull();
		});

		it("is a no-op when filePath is not present", () => {
			const cache = new ContextCache();
			expect(() => cache.invalidate("missing.ts")).not.toThrow();
		});
	});

	describe("stats()", () => {
		it("returns zero counts initially", () => {
			const cache = new ContextCache();
			expect(cache.stats()).toEqual({ hits: 0, misses: 0, entries: 0 });
		});

		it("accumulates hits and misses across multiple get() calls", () => {
			const cache = new ContextCache();
			const entry = makeEntry("a.ts", 1);
			cache.set(entry);

			cache.get("a.ts", 1); // hit
			cache.get("a.ts", 1); // hit
			cache.get("missing.ts", 1); // miss

			const s = cache.stats();
			expect(s.hits).toBe(2);
			expect(s.misses).toBe(1);
		});

		it("reflects entry count after set and invalidate", () => {
			const cache = new ContextCache();
			cache.set(makeEntry("a.ts", 1));
			cache.set(makeEntry("b.ts", 2));
			cache.invalidate("a.ts");

			expect(cache.stats().entries).toBe(1);
		});
	});

	describe("clear()", () => {
		it("removes all entries", () => {
			const cache = new ContextCache();
			cache.set(makeEntry("a.ts", 1));
			cache.set(makeEntry("b.ts", 2));
			cache.clear();

			expect(cache.stats().entries).toBe(0);
			expect(cache.get("a.ts", 1)).toBeNull();
		});

		it("does not reset hit/miss counters", () => {
			const cache = new ContextCache();
			cache.set(makeEntry("a.ts", 1));
			cache.get("a.ts", 1); // hit
			cache.clear();

			expect(cache.stats().hits).toBe(1);
		});
	});

	describe("custom capacity", () => {
		it("accepts a custom capacity in the constructor", () => {
			const cache = new ContextCache({ capacity: 2 });
			cache.set(makeEntry("a.ts", 1));
			cache.set(makeEntry("b.ts", 2));
			cache.set(makeEntry("c.ts", 3)); // triggers eviction of a.ts (LRU)

			expect(cache.get("a.ts", 1)).toBeNull(); // evicted
			expect(cache.get("b.ts", 2)).not.toBeNull();
			expect(cache.get("c.ts", 3)).not.toBeNull();
		});
	});
});
