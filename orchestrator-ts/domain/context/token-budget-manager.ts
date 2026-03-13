import { getEncoding } from "js-tiktoken";
import type {
	ITokenBudgetManager,
	LayerBudgetMap,
	LayerId,
	TokenBudgetConfig,
} from "../../application/ports/context";
import { LAYER_REGISTRY } from "./layer-registry";

export class TokenBudgetManager implements ITokenBudgetManager {
	// biome-ignore lint/suspicious/noExplicitAny: internal encoder type not exported by js-tiktoken
	private _encoder: any;

	constructor() {
		this._encoder = getEncoding("cl100k_base");
	}

	countTokens(text: string): number {
		try {
			return this._encoder.encode(text).length;
		} catch {
			console.warn(
				"[TokenBudgetManager] tiktoken encode error — falling back to length/4 approximation",
			);
			return Math.ceil(text.length / 4);
		}
	}

	allocate(config: TokenBudgetConfig): LayerBudgetMap {
		const effectiveTotal = Math.floor(
			config.modelTokenLimit * (1 - config.safetyBufferFraction),
		);

		const defaultSum = LAYER_REGISTRY.reduce(
			(sum, layer) => sum + (config.layerBudgets[layer.id] ?? layer.defaultBudget),
			0,
		);

		const scaleFactor = defaultSum > effectiveTotal ? effectiveTotal / defaultSum : 1;

		const budgets: Record<LayerId, number> = {} as Record<LayerId, number>;
		let allocatedSum = 0;

		for (const layer of LAYER_REGISTRY) {
			const raw = (config.layerBudgets[layer.id] ?? layer.defaultBudget) * scaleFactor;
			const budget = Math.floor(raw);
			budgets[layer.id] = budget;
			allocatedSum += budget;
		}

		return { budgets, totalBudget: allocatedSum };
	}

	checkBudget(content: string, budget: number): { tokensUsed: number; overBy: number } {
		const tokensUsed = this.countTokens(content);
		const overBy = Math.max(0, tokensUsed - budget);
		return { tokensUsed, overBy };
	}

	checkTotal(
		layerTokenCounts: ReadonlyArray<{ layerId: LayerId; tokens: number }>,
		totalBudget: number,
	): number {
		const sum = layerTokenCounts.reduce((acc, l) => acc + l.tokens, 0);
		return sum - totalBudget;
	}
}
