import type { ITokenBudgetManager, LayerBudgetMap, LayerId, TokenBudgetConfig } from "@/application/ports/context";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { LAYER_REGISTRY } from "./layer-registry";

// Initialized once at module load; reused across all TokenBudgetManager instances.
const DEFAULT_ENCODER = getEncoding("cl100k_base");

export class TokenBudgetManager implements ITokenBudgetManager {
  private readonly encoder: Tiktoken;

  constructor(encoder?: Tiktoken) {
    this.encoder = encoder ?? DEFAULT_ENCODER;
  }

  countTokens(text: string): number {
    try {
      return this.encoder.encode(text).length;
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

    // Single pass: collect per-layer defaults and their sum.
    const budgets: Record<LayerId, number> = {} as Record<LayerId, number>;
    let defaultSum = 0;
    for (const layer of LAYER_REGISTRY) {
      const budget = config.layerBudgets[layer.id] ?? layer.defaultBudget;
      budgets[layer.id] = budget;
      defaultSum += budget;
    }

    // Fast path: defaults already fit within the effective limit.
    if (defaultSum <= effectiveTotal) {
      return { budgets, totalBudget: defaultSum };
    }

    // Scale down proportionally to fit.
    const scaleFactor = effectiveTotal / defaultSum;
    let allocatedSum = 0;
    for (const layer of LAYER_REGISTRY) {
      const scaled = Math.floor(budgets[layer.id] * scaleFactor);
      budgets[layer.id] = scaled;
      allocatedSum += scaled;
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
