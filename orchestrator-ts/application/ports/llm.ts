export type LlmErrorCategory = "network" | "rate_limit" | "api_error";

export interface LlmError {
  readonly category: LlmErrorCategory;
  readonly message: string;
  readonly originalError: unknown;
}

export interface LlmResponse {
  readonly content: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export type LlmResult =
  | { readonly ok: true; readonly value: LlmResponse }
  | { readonly ok: false; readonly error: LlmError };

export interface LlmCompleteOptions {
  readonly maxTokens?: number;
}

export interface LlmProviderPort {
  /** Send a prompt and return a result. Never throws — errors are in the { ok: false } branch. */
  complete(prompt: string, options?: LlmCompleteOptions): Promise<LlmResult>;
  /** Discard all accumulated conversation history so the next call starts fresh. */
  clearContext(): void;
}
