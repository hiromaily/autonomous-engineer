import { describe, expect, it, mock } from "bun:test";
import type {
	LayerBudgetConfig,
	TokenBudgetConfig,
} from "../../../application/ports/context";
import { TokenBudgetManager } from "../../../domain/context/token-budget-manager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LAYER_BUDGETS: LayerBudgetConfig = {
	systemInstructions: 1000,
	taskDescription: 500,
	activeSpecification: 2000,
	codeContext: 4000,
	repositoryState: 500,
	memoryRetrieval: 1500,
	toolResults: 2000,
};
// sum = 11500

const DEFAULT_CONFIG: TokenBudgetConfig = {
	layerBudgets: DEFAULT_LAYER_BUDGETS,
	modelTokenLimit: 16000,
	safetyBufferFraction: 0.05,
};

// ---------------------------------------------------------------------------
// countTokens
// ---------------------------------------------------------------------------

describe("TokenBudgetManager.countTokens", () => {
	it("returns correct token count for a known string", () => {
		const mgr = new TokenBudgetManager();
		// "hello world" → 2 tokens in cl100k_base (verified by smoke test)
		expect(mgr.countTokens("hello world")).toBe(2);
	});

	it("returns 0 for an empty string", () => {
		const mgr = new TokenBudgetManager();
		expect(mgr.countTokens("")).toBe(0);
	});

	it("returns a positive count for a multi-word string", () => {
		const mgr = new TokenBudgetManager();
		const text = "The quick brown fox jumps over the lazy dog";
		const count = mgr.countTokens(text);
		expect(count).toBeGreaterThan(0);
	});

	it("falls back to Math.ceil(length / 4) when tiktoken throws", () => {
		const mgr = new TokenBudgetManager();
		// Force an error by temporarily overriding the encoder
		(mgr as unknown as { _encoder: { encode: () => never } })._encoder = {
			encode: () => {
				throw new Error("simulated encode error");
			},
		};
		const text = "hello world"; // length = 11, ceil(11/4) = 3
		const result = mgr.countTokens(text);
		expect(result).toBe(Math.ceil("hello world".length / 4));
	});
});

// ---------------------------------------------------------------------------
// allocate
// ---------------------------------------------------------------------------

describe("TokenBudgetManager.allocate", () => {
	it("returns budgets for all seven layers", () => {
		const mgr = new TokenBudgetManager();
		const map = mgr.allocate(DEFAULT_CONFIG);
		const keys = Object.keys(map.budgets) as Array<keyof typeof map.budgets>;
		expect(keys).toHaveLength(7);
		expect(keys).toContain("systemInstructions");
		expect(keys).toContain("taskDescription");
		expect(keys).toContain("activeSpecification");
		expect(keys).toContain("codeContext");
		expect(keys).toContain("repositoryState");
		expect(keys).toContain("memoryRetrieval");
		expect(keys).toContain("toolResults");
	});

	it("sums to at most the effective model limit (after safety buffer)", () => {
		const mgr = new TokenBudgetManager();
		const map = mgr.allocate(DEFAULT_CONFIG);
		const effectiveTotal = Math.floor(
			DEFAULT_CONFIG.modelTokenLimit * (1 - DEFAULT_CONFIG.safetyBufferFraction),
		);
		const sum = Object.values(map.budgets).reduce((a, b) => a + b, 0);
		expect(sum).toBeLessThanOrEqual(effectiveTotal);
		expect(map.totalBudget).toBeLessThanOrEqual(effectiveTotal);
	});

	it("totalBudget matches the sum of per-layer budgets", () => {
		const mgr = new TokenBudgetManager();
		const map = mgr.allocate(DEFAULT_CONFIG);
		const sum = Object.values(map.budgets).reduce((a, b) => a + b, 0);
		expect(map.totalBudget).toBe(sum);
	});

	it("proportionally scales layers when defaults exceed effective limit", () => {
		const mgr = new TokenBudgetManager();
		// Use a tiny model limit so defaults (11500) are scaled down
		const config: TokenBudgetConfig = {
			...DEFAULT_CONFIG,
			modelTokenLimit: 4000,
			safetyBufferFraction: 0.0,
		};
		const map = mgr.allocate(config);
		const sum = Object.values(map.budgets).reduce((a, b) => a + b, 0);
		expect(sum).toBeLessThanOrEqual(4000);
		// codeContext should still be the largest layer
		expect(map.budgets.codeContext).toBeGreaterThan(map.budgets.taskDescription);
	});

	it("does not scale down when defaults already fit within effective limit", () => {
		const mgr = new TokenBudgetManager();
		// Large model limit — no scaling needed
		const config: TokenBudgetConfig = {
			...DEFAULT_CONFIG,
			modelTokenLimit: 128000,
			safetyBufferFraction: 0.05,
		};
		const map = mgr.allocate(config);
		// Each budget should equal its default (no scaling)
		expect(map.budgets.systemInstructions).toBe(1000);
		expect(map.budgets.taskDescription).toBe(500);
		expect(map.budgets.codeContext).toBe(4000);
	});

	it("all budget values are non-negative integers", () => {
		const mgr = new TokenBudgetManager();
		const map = mgr.allocate(DEFAULT_CONFIG);
		for (const budget of Object.values(map.budgets)) {
			expect(budget).toBeGreaterThanOrEqual(0);
			expect(Number.isInteger(budget)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// checkBudget
// ---------------------------------------------------------------------------

describe("TokenBudgetManager.checkBudget", () => {
	it("returns overBy = 0 when content fits within budget", () => {
		const mgr = new TokenBudgetManager();
		const result = mgr.checkBudget("hello world", 100);
		expect(result.overBy).toBe(0);
		expect(result.tokensUsed).toBe(2);
	});

	it("returns overBy > 0 when content exceeds budget", () => {
		const mgr = new TokenBudgetManager();
		// "hello world" = 2 tokens; budget 1 → overBy 1
		const result = mgr.checkBudget("hello world", 1);
		expect(result.tokensUsed).toBe(2);
		expect(result.overBy).toBe(1);
	});

	it("returns overBy = 0 when tokensUsed exactly equals budget", () => {
		const mgr = new TokenBudgetManager();
		const text = "hello world"; // 2 tokens
		const result = mgr.checkBudget(text, 2);
		expect(result.overBy).toBe(0);
		expect(result.tokensUsed).toBe(2);
	});

	it("returns tokensUsed = 0 for empty string", () => {
		const mgr = new TokenBudgetManager();
		const result = mgr.checkBudget("", 100);
		expect(result.tokensUsed).toBe(0);
		expect(result.overBy).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// checkTotal
// ---------------------------------------------------------------------------

describe("TokenBudgetManager.checkTotal", () => {
	it("returns a negative value (headroom) when total is under budget", () => {
		const mgr = new TokenBudgetManager();
		const result = mgr.checkTotal(
			[
				{ layerId: "systemInstructions", tokens: 100 },
				{ layerId: "taskDescription", tokens: 200 },
			],
			1000,
		);
		// 300 − 1000 = −700
		expect(result).toBe(-700);
	});

	it("returns 0 when total exactly equals budget", () => {
		const mgr = new TokenBudgetManager();
		const result = mgr.checkTotal(
			[
				{ layerId: "systemInstructions", tokens: 500 },
				{ layerId: "taskDescription", tokens: 500 },
			],
			1000,
		);
		expect(result).toBe(0);
	});

	it("returns a positive value (overage) when total exceeds budget", () => {
		const mgr = new TokenBudgetManager();
		const result = mgr.checkTotal(
			[
				{ layerId: "systemInstructions", tokens: 600 },
				{ layerId: "taskDescription", tokens: 600 },
			],
			1000,
		);
		// 1200 − 1000 = 200
		expect(result).toBe(200);
	});

	it("returns a negative value equal to -budget when given empty layer list", () => {
		const mgr = new TokenBudgetManager();
		const result = mgr.checkTotal([], 500);
		expect(result).toBe(-500);
	});
});
