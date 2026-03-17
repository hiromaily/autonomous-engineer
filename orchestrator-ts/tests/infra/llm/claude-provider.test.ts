import type { ILogger } from "@/application/ports/logger";
import { ClaudeProvider } from "@/infra/llm/claude-provider";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal Anthropic API response shape
// ---------------------------------------------------------------------------

function makeSuccessResponse(text: string, inputTokens = 10, outputTokens = 5): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text, citations: [] } as unknown as Anthropic.TextBlock],
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens } as unknown as Anthropic.Usage,
  } as unknown as Anthropic.Message;
}

function makeClient(createFn: () => Promise<Anthropic.Message>): Anthropic {
  return { messages: { create: mock(createFn) } } as unknown as Anthropic;
}

// ---------------------------------------------------------------------------
// complete() — success path
// ---------------------------------------------------------------------------

describe("ClaudeProvider.complete()", () => {
  it("returns ok: true with content and token usage on success", async () => {
    const client = makeClient(() => Promise.resolve(makeSuccessResponse("answer text", 15, 8)));
    const provider = new ClaudeProvider({ apiKey: "test-key", modelName: "claude-sonnet-4-6" }, client);

    const result = await provider.complete("What is 2+2?");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("answer text");
      expect(result.value.usage.inputTokens).toBe(15);
      expect(result.value.usage.outputTokens).toBe(8);
    }
  });

  it("sends the prompt as a user message to the API", async () => {
    const createMock = mock(() => Promise.resolve(makeSuccessResponse("ok")));
    const client = { messages: { create: createMock } } as unknown as Anthropic;
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client);

    await provider.complete("Hello Claude");

    expect(createMock).toHaveBeenCalledTimes(1);
    const params = (createMock.mock.calls as unknown[][])[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(params.messages).toEqual([{ role: "user", content: "Hello Claude" }]);
    expect(params.model).toBe("claude-sonnet-4-6");
  });

  it("passes maxTokens from options to the API call", async () => {
    const createMock = mock(() => Promise.resolve(makeSuccessResponse("ok")));
    const client = { messages: { create: createMock } } as unknown as Anthropic;
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client);

    await provider.complete("prompt", { maxTokens: 512 });

    const params = (createMock.mock.calls as unknown[][])[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(params.max_tokens).toBe(512);
  });

  it("accumulates conversation history across calls", async () => {
    const createMock = mock(() => Promise.resolve(makeSuccessResponse("reply")));
    const client = { messages: { create: createMock } } as unknown as Anthropic;
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client);

    await provider.complete("first message");
    await provider.complete("second message");

    expect(createMock).toHaveBeenCalledTimes(2);
    const params = (createMock.mock.calls as unknown[][])[1]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    // Second call should include the first user message and assistant reply
    expect(params.messages.length).toBe(3);
    expect(params.messages[0]).toEqual({ role: "user", content: "first message" });
    expect(params.messages[1]).toEqual({ role: "assistant", content: "reply" });
    expect(params.messages[2]).toEqual({ role: "user", content: "second message" });
  });
});

// ---------------------------------------------------------------------------
// complete() — error path (never throws)
// ---------------------------------------------------------------------------

describe("ClaudeProvider.complete() — error handling", () => {
  it("returns ok: false with category network on APIConnectionError", async () => {
    const client = makeClient(() => Promise.reject(new Anthropic.APIConnectionError({ message: "ECONNREFUSED" })));
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client);

    const result = await provider.complete("prompt");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("network");
      expect(result.error.originalError).toBeInstanceOf(Anthropic.APIConnectionError);
    }
  });

  it("returns ok: false with category rate_limit on RateLimitError", async () => {
    const rateLimitErr = new Anthropic.RateLimitError(429, {}, "rate limited", new Headers());
    const client = makeClient(() => Promise.reject(rateLimitErr));
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client);

    const result = await provider.complete("prompt");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("rate_limit");
    }
  });

  it("returns ok: false with category api_error for all other errors", async () => {
    const client = makeClient(() => Promise.reject(new Error("unexpected server error")));
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client);

    const result = await provider.complete("prompt");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("api_error");
      expect(result.error.message).toBe("unexpected server error");
    }
  });

  it("never throws — always returns LlmResult", async () => {
    const client = makeClient(() => Promise.reject(new Error("any error")));
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client);

    await expect(provider.complete("prompt")).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// clearContext()
// ---------------------------------------------------------------------------

describe("ClaudeProvider.clearContext()", () => {
  it("resets message history so next call starts fresh", async () => {
    const createMock = mock(() => Promise.resolve(makeSuccessResponse("reply")));
    const client = { messages: { create: createMock } } as unknown as Anthropic;
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client);

    await provider.complete("first message");
    provider.clearContext();
    await provider.complete("fresh start");

    const params = (createMock.mock.calls as unknown[][])[1]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(params.messages).toEqual([{ role: "user", content: "fresh start" }]);
  });

  it("can be called multiple times without error", () => {
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" });
    expect(() => {
      provider.clearContext();
      provider.clearContext();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// logger integration (task 6.2)
// ---------------------------------------------------------------------------

function makeLogger(): ILogger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

describe("ClaudeProvider logger integration", () => {
  it("emits debug before the LLM call with callIndex and promptPreview", async () => {
    const client = makeClient(() => Promise.resolve(makeSuccessResponse("ok")));
    const logger = makeLogger();
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client, logger);

    await provider.complete("Hello world");

    const debugCalls = (logger.debug as ReturnType<typeof mock>).mock.calls as [string, object?][];
    const beforeCallEntry = debugCalls.find(([msg]) => msg === "LLM call");
    expect(beforeCallEntry).toBeDefined();
    expect(beforeCallEntry?.[1]).toMatchObject({ callIndex: 1, promptPreview: "Hello world" });
  });

  it("truncates promptPreview to 500 characters", async () => {
    const client = makeClient(() => Promise.resolve(makeSuccessResponse("ok")));
    const logger = makeLogger();
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client, logger);
    const longPrompt = "x".repeat(1000);

    await provider.complete(longPrompt);

    const debugCalls = (logger.debug as ReturnType<typeof mock>).mock.calls as [string, object?][];
    const beforeCallEntry = debugCalls.find(([msg]) => msg === "LLM call");
    const ctx = beforeCallEntry?.[1] as { promptPreview: string } | undefined;
    expect(ctx?.promptPreview.length).toBe(500);
  });

  it("emits debug after a successful response with callIndex and responseSummary", async () => {
    const client = makeClient(() => Promise.resolve(makeSuccessResponse("response text")));
    const logger = makeLogger();
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client, logger);

    await provider.complete("prompt");

    const debugCalls = (logger.debug as ReturnType<typeof mock>).mock.calls as [string, object?][];
    const afterCallEntry = debugCalls.find(([msg]) => msg === "LLM response");
    expect(afterCallEntry).toBeDefined();
    expect(afterCallEntry?.[1]).toMatchObject({ callIndex: 1, responseSummary: "response text" });
  });

  it("emits error on LLM failure with callIndex, errorCategory, and errorMessage", async () => {
    const client = makeClient(() => Promise.reject(new Error("api error")));
    const logger = makeLogger();
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client, logger);

    await provider.complete("prompt");

    const errorCalls = (logger.error as ReturnType<typeof mock>).mock.calls as [string, object?][];
    const llmErrorEntry = errorCalls.find(([msg]) => msg === "LLM error");
    expect(llmErrorEntry).toBeDefined();
    expect(llmErrorEntry?.[1]).toMatchObject({
      callIndex: 1,
      errorCategory: "api_error",
      errorMessage: "api error",
    });
  });

  it("increments callIndex monotonically across calls", async () => {
    const client = makeClient(() => Promise.resolve(makeSuccessResponse("ok")));
    const logger = makeLogger();
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client, logger);

    await provider.complete("first");
    await provider.complete("second");

    const debugCalls = (logger.debug as ReturnType<typeof mock>).mock.calls as [string, object?][];
    const callEntries = debugCalls.filter(([msg]) => msg === "LLM call");
    expect(callEntries[0]?.[1]).toMatchObject({ callIndex: 1 });
    expect(callEntries[1]?.[1]).toMatchObject({ callIndex: 2 });
  });

  it("never logs at info or warn level during LLM interactions", async () => {
    const client = makeClient(() => Promise.resolve(makeSuccessResponse("ok")));
    const logger = makeLogger();
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client, logger);

    await provider.complete("prompt");

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not throw when no logger is provided", async () => {
    const client = makeClient(() => Promise.resolve(makeSuccessResponse("ok")));
    const provider = new ClaudeProvider({ apiKey: "key", modelName: "claude-sonnet-4-6" }, client);

    await expect(provider.complete("prompt")).resolves.toBeDefined();
  });
});
