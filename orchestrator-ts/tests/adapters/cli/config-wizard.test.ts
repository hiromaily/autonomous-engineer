import { ConfigWizard } from "@/adapters/cli/config-wizard";
import { describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal prompts mock helpers
// ---------------------------------------------------------------------------

function makePrompts(overrides: {
  intro?: ReturnType<typeof mock>;
  select?: ReturnType<typeof mock>;
  text?: ReturnType<typeof mock>;
  isCancel?: ReturnType<typeof mock>;
  note?: ReturnType<typeof mock>;
}) {
  return {
    intro: overrides.intro ?? mock(() => {}),
    select: overrides.select ?? mock(async () => "claude"),
    text: overrides.text ?? mock(async () => "claude-opus-4-6"),
    isCancel: overrides.isCancel ?? mock((_v: unknown) => false),
    note: overrides.note ?? mock(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Happy path: four-step prompt sequence with hardcoded defaults
// ---------------------------------------------------------------------------

describe("ConfigWizard — prompt sequence", () => {
  it("returns WizardInput with all four fields on happy path", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "");
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    expect(result).not.toBe("cancelled");
    if (result !== "cancelled") {
      expect(result.provider).toBe("claude");
      expect(result.modelName).toBe("claude-opus-4-6");
      expect(result.sddFramework).toBe("cc-sdd");
      expect(result.specDir).toBe(".kiro/specs");
    }
  });

  it("calls select twice (provider and sddFramework) and text twice (modelName and specDir)", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "value");
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    await wizard.run();

    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(textMock).toHaveBeenCalledTimes(2);
  });

  it("uses 'claude' as the default provider", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => {
      // Return the initialValue so we can inspect it
      return opts.initialValue ?? "no-default";
    });
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "x");
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    // The first select call should have initialValue: 'claude'
    const firstCallArgs = (selectMock.mock.calls as Array<[{ initialValue?: string }]>)[0]?.[0];
    expect(firstCallArgs?.initialValue).toBe("claude");
    if (result !== "cancelled") {
      expect(result.provider).toBe("claude");
    }
  });

  it("uses 'claude-opus-4-6' as the default modelName", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "");
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    // The first text call should have defaultValue: 'claude-opus-4-6'
    const firstTextCallArgs = (textMock.mock.calls as Array<[{ defaultValue?: string }]>)[0]?.[0];
    expect(firstTextCallArgs?.defaultValue).toBe("claude-opus-4-6");
    if (result !== "cancelled") {
      expect(result.modelName).toBe("claude-opus-4-6");
    }
  });

  it("uses 'cc-sdd' as the default sddFramework", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "x");
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    // The second select call should have initialValue: 'cc-sdd'
    const secondCallArgs = (selectMock.mock.calls as Array<[{ initialValue?: string }]>)[1]?.[0];
    expect(secondCallArgs?.initialValue).toBe("cc-sdd");
    if (result !== "cancelled") {
      expect(result.sddFramework).toBe("cc-sdd");
    }
  });

  it("uses '.kiro/specs' as the default specDir", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "");
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    // The second text call should have defaultValue: '.kiro/specs'
    const secondTextCallArgs = (textMock.mock.calls as Array<[{ defaultValue?: string }]>)[1]?.[0];
    expect(secondTextCallArgs?.defaultValue).toBe(".kiro/specs");
    if (result !== "cancelled") {
      expect(result.specDir).toBe(".kiro/specs");
    }
  });

  it("reflects user-entered values in the returned WizardInput", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    // Second text call returns a custom specDir
    let textCallCount = 0;
    const textMock = mock(async () => {
      textCallCount++;
      if (textCallCount === 1) return "claude-sonnet-4-6";
      return "custom/specs";
    });
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    expect(result).not.toBe("cancelled");
    if (result !== "cancelled") {
      expect(result.modelName).toBe("claude-sonnet-4-6");
      expect(result.specDir).toBe("custom/specs");
    }
  });
});

// ---------------------------------------------------------------------------
// Re-prompting: empty required text fields
// ---------------------------------------------------------------------------

describe("ConfigWizard — re-prompt on empty text input", () => {
  it("re-prompts for modelName if the user submits an empty string", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    let textCallCount = 0;
    const textMock = mock(async () => {
      textCallCount++;
      if (textCallCount === 1) return ""; // First modelName attempt: empty
      if (textCallCount === 2) return "claude-opus-4-6"; // Second attempt: valid
      return ".kiro/specs"; // specDir
    });
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    // text should be called 3 times: empty modelName, valid modelName, specDir
    expect(textMock).toHaveBeenCalledTimes(3);
    expect(result).not.toBe("cancelled");
    if (result !== "cancelled") {
      expect(result.modelName).toBe("claude-opus-4-6");
    }
  });

  it("re-prompts for specDir if the user submits an empty string", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    let textCallCount = 0;
    const textMock = mock(async () => {
      textCallCount++;
      if (textCallCount === 1) return "claude-opus-4-6"; // modelName
      if (textCallCount === 2) return ""; // First specDir attempt: empty
      return ".kiro/specs"; // Second specDir attempt: valid
    });
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    // text should be called 3 times: modelName, empty specDir, valid specDir
    expect(textMock).toHaveBeenCalledTimes(3);
    expect(result).not.toBe("cancelled");
    if (result !== "cancelled") {
      expect(result.specDir).toBe(".kiro/specs");
    }
  });

  it("keeps re-prompting for modelName until a non-empty value is entered", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    let textCallCount = 0;
    const textMock = mock(async () => {
      textCallCount++;
      if (textCallCount === 1) return ""; // empty
      if (textCallCount === 2) return "   "; // whitespace only
      if (textCallCount === 3) return "claude-haiku-4-5"; // valid
      return ".kiro/specs"; // specDir
    });
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    expect(textMock).toHaveBeenCalledTimes(4);
    if (result !== "cancelled") {
      expect(result.modelName).toBe("claude-haiku-4-5");
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt order: provider → modelName → sddFramework → specDir
// ---------------------------------------------------------------------------

describe("ConfigWizard — prompt ordering", () => {
  it("calls prompts in the documented order", async () => {
    const callOrder: string[] = [];
    const selectMock = mock(async (opts: { message: string; initialValue?: string }) => {
      callOrder.push(`select:${opts.message}`);
      return opts.initialValue ?? "claude";
    });
    const textMock = mock(async (opts: { message: string; defaultValue?: string }) => {
      callOrder.push(`text:${opts.message}`);
      return opts.defaultValue ?? "value";
    });
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    await wizard.run();

    expect(callOrder[0]).toMatch(/select/);
    expect(callOrder[0]).toMatch(/provider|LLM|llm/i);
    expect(callOrder[1]).toMatch(/text/);
    expect(callOrder[1]).toMatch(/model/i);
    expect(callOrder[2]).toMatch(/select/);
    expect(callOrder[2]).toMatch(/framework|sdd/i);
    expect(callOrder[3]).toMatch(/text/);
    expect(callOrder[3]).toMatch(/spec|dir/i);
  });
});

// ---------------------------------------------------------------------------
// Task 3.2: Pre-populate prompts from defaults
// ---------------------------------------------------------------------------

describe("ConfigWizard — pre-populate from defaults", () => {
  it("uses defaults.provider as initialValue for the provider select", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "value");
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    await wizard.run({ provider: "openai" });

    const firstCallArgs = (selectMock.mock.calls as Array<[{ initialValue?: string }]>)[0]?.[0];
    expect(firstCallArgs?.initialValue).toBe("openai");
  });

  it("uses defaults.modelName as defaultValue for the modelName text prompt", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "value");
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    await wizard.run({ modelName: "claude-sonnet-4-6" });

    const firstTextCallArgs = (textMock.mock.calls as Array<[{ defaultValue?: string }]>)[0]?.[0];
    expect(firstTextCallArgs?.defaultValue).toBe("claude-sonnet-4-6");
  });

  it("uses defaults.sddFramework as initialValue for the framework select", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "value");
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    await wizard.run({ sddFramework: "openspec" });

    const secondSelectCallArgs = (selectMock.mock.calls as Array<[{ initialValue?: string }]>)[1]?.[0];
    expect(secondSelectCallArgs?.initialValue).toBe("openspec");
  });

  it("uses defaults.specDir as defaultValue for the specDir text prompt", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "value");
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    await wizard.run({ specDir: "custom/specs" });

    const secondTextCallArgs = (textMock.mock.calls as Array<[{ defaultValue?: string }]>)[1]?.[0];
    expect(secondTextCallArgs?.defaultValue).toBe("custom/specs");
  });

  it("falls back to builtin defaults when no defaults object is provided", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "value");
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    await wizard.run();

    const firstSelectArgs = (selectMock.mock.calls as Array<[{ initialValue?: string }]>)[0]?.[0];
    const firstTextArgs = (textMock.mock.calls as Array<[{ defaultValue?: string }]>)[0]?.[0];
    const secondSelectArgs = (selectMock.mock.calls as Array<[{ initialValue?: string }]>)[1]?.[0];
    const secondTextArgs = (textMock.mock.calls as Array<[{ defaultValue?: string }]>)[1]?.[0];

    expect(firstSelectArgs?.initialValue).toBe("claude");
    expect(firstTextArgs?.defaultValue).toBe("claude-opus-4-6");
    expect(secondSelectArgs?.initialValue).toBe("cc-sdd");
    expect(secondTextArgs?.defaultValue).toBe(".kiro/specs");
  });

  it("partial defaults: only overrides provided fields, keeps builtin defaults for others", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "value");
    const prompts = makePrompts({ select: selectMock, text: textMock });

    const wizard = new ConfigWizard(prompts);
    // Only override modelName; others should remain at builtin defaults
    await wizard.run({ modelName: "claude-haiku-4-5" });

    const firstSelectArgs = (selectMock.mock.calls as Array<[{ initialValue?: string }]>)[0]?.[0];
    const firstTextArgs = (textMock.mock.calls as Array<[{ defaultValue?: string }]>)[0]?.[0];
    const secondSelectArgs = (selectMock.mock.calls as Array<[{ initialValue?: string }]>)[1]?.[0];
    const secondTextArgs = (textMock.mock.calls as Array<[{ defaultValue?: string }]>)[1]?.[0];

    expect(firstSelectArgs?.initialValue).toBe("claude"); // builtin
    expect(firstTextArgs?.defaultValue).toBe("claude-haiku-4-5"); // overridden
    expect(secondSelectArgs?.initialValue).toBe("cc-sdd"); // builtin
    expect(secondTextArgs?.defaultValue).toBe(".kiro/specs"); // builtin
  });
});

// ---------------------------------------------------------------------------
// Task 3.2: Cancellation at each step
// ---------------------------------------------------------------------------

const CANCEL_SYMBOL = Symbol("cancel");

describe("ConfigWizard — cancellation handling", () => {
  it("returns 'cancelled' when user cancels at the provider prompt", async () => {
    const selectMock = mock(async () => CANCEL_SYMBOL);
    const isCancelMock = mock((v: unknown) => v === CANCEL_SYMBOL);
    const prompts = makePrompts({ select: selectMock, isCancel: isCancelMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    expect(result).toBe("cancelled");
    // Only one select call; text should not be called at all
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it("returns 'cancelled' when user cancels at the modelName prompt", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    const textMock = mock(async () => CANCEL_SYMBOL);
    const isCancelMock = mock((v: unknown) => v === CANCEL_SYMBOL);
    const prompts = makePrompts({ select: selectMock, text: textMock, isCancel: isCancelMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    expect(result).toBe("cancelled");
    expect(selectMock).toHaveBeenCalledTimes(1); // provider only
    expect(textMock).toHaveBeenCalledTimes(1); // modelName only
  });

  it("returns 'cancelled' when user cancels at the sddFramework prompt", async () => {
    let callCount = 0;
    const selectMock = mock(async (opts: { initialValue?: string }) => {
      callCount++;
      if (callCount === 1) return opts.initialValue ?? "claude"; // provider ok
      return CANCEL_SYMBOL; // sddFramework: cancel
    });
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "value");
    const isCancelMock = mock((v: unknown) => v === CANCEL_SYMBOL);
    const prompts = makePrompts({ select: selectMock, text: textMock, isCancel: isCancelMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    expect(result).toBe("cancelled");
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(textMock).toHaveBeenCalledTimes(1); // modelName only; specDir not reached
  });

  it("returns 'cancelled' when user cancels at the specDir prompt", async () => {
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    let textCallCount = 0;
    const textMock = mock(async () => {
      textCallCount++;
      if (textCallCount === 1) return "value"; // modelName ok
      return CANCEL_SYMBOL; // specDir: cancel
    });
    const isCancelMock = mock((v: unknown) => v === CANCEL_SYMBOL);
    const prompts = makePrompts({ select: selectMock, text: textMock, isCancel: isCancelMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    expect(result).toBe("cancelled");
    expect(textMock).toHaveBeenCalledTimes(2);
  });

  it("does not call further prompts after cancellation", async () => {
    const selectMock = mock(async () => CANCEL_SYMBOL);
    const textMock = mock(async () => "value");
    const isCancelMock = mock((v: unknown) => v === CANCEL_SYMBOL);
    const prompts = makePrompts({ select: selectMock, text: textMock, isCancel: isCancelMock });

    const wizard = new ConfigWizard(prompts);
    await wizard.run();

    expect(textMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task 3.2: Post-wizard API key guidance message (Req 3.6)
// ---------------------------------------------------------------------------

describe("ConfigWizard — post-wizard API key guidance", () => {
  it("displays a note about AES_LLM_API_KEY after all prompts complete successfully", async () => {
    const noteMock = mock(() => {});
    const selectMock = mock(async (opts: { initialValue?: string }) => opts.initialValue ?? "claude");
    const textMock = mock(async (opts: { defaultValue?: string }) => opts.defaultValue ?? "value");
    const prompts = makePrompts({ select: selectMock, text: textMock, note: noteMock });

    const wizard = new ConfigWizard(prompts);
    await wizard.run();

    expect(noteMock).toHaveBeenCalledTimes(1);
    const callArgs = (noteMock.mock.calls as unknown as Array<[string]>)[0];
    const message = callArgs?.[0] ?? "";
    expect(message).toMatch(/AES_LLM_API_KEY/);
  });

  it("does NOT display the API key note when the wizard is cancelled", async () => {
    const noteMock = mock(() => {});
    const selectMock = mock(async () => CANCEL_SYMBOL);
    const isCancelMock = mock((v: unknown) => v === CANCEL_SYMBOL);
    const prompts = makePrompts({ select: selectMock, isCancel: isCancelMock, note: noteMock });

    const wizard = new ConfigWizard(prompts);
    const result = await wizard.run();

    expect(result).toBe("cancelled");
    expect(noteMock).not.toHaveBeenCalled();
  });
});
