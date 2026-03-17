import type { LlmCompleteOptions, LlmErrorCategory, LlmProviderPort, LlmResult } from "@/application/ports/llm";
import type { ILogger } from "@/application/ports/logger";
import { getErrorMessage } from "@/infra/utils/errors";
import Anthropic from "@anthropic-ai/sdk";

export interface ClaudeProviderConfig {
  readonly apiKey: string;
  readonly modelName: string;
}

type HistoryEntry = { role: "user" | "assistant"; content: string };

const DEFAULT_MAX_TOKENS = 8192;

export class ClaudeProvider implements LlmProviderPort {
  private readonly client: Anthropic;
  private readonly modelName: string;
  private readonly logger: ILogger | undefined;
  private messages: HistoryEntry[] = [];
  private callIndex = 0;

  constructor(config: ClaudeProviderConfig, client?: Anthropic, logger?: ILogger) {
    this.modelName = config.modelName;
    this.client = client ?? new Anthropic({ apiKey: config.apiKey });
    this.logger = logger;
  }

  async complete(prompt: string, options?: LlmCompleteOptions): Promise<LlmResult> {
    this.callIndex++;
    const callIndex = this.callIndex;
    const promptPreview = prompt.slice(0, 500);
    this.logger?.debug("LLM call", { callIndex, promptPreview });

    this.messages.push({ role: "user", content: prompt });

    try {
      const response = await this.client.messages.create({
        model: this.modelName,
        max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [...this.messages],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map(block => block.text)
        .join("");
      this.messages.push({ role: "assistant", content: text });

      this.logger?.debug("LLM response", { callIndex, responseSummary: text.slice(0, 200) });

      return {
        ok: true,
        value: {
          content: text,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        },
      };
    } catch (err) {
      const errorCategory = categorize(err);
      const errorMessage = getErrorMessage(err);
      this.logger?.error("LLM error", { callIndex, errorCategory, errorMessage });
      return {
        ok: false,
        error: {
          category: errorCategory,
          message: errorMessage,
          originalError: err,
        },
      };
    }
  }

  clearContext(): void {
    this.messages = [];
  }
}

function categorize(err: unknown): LlmErrorCategory {
  if (err instanceof Anthropic.APIConnectionError) return "network";
  if (err instanceof Anthropic.RateLimitError) return "rate_limit";
  return "api_error";
}
