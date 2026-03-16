import type { IPermissionSystem } from "@/domain/tools/permissions";
import type { IToolRegistry } from "@/domain/tools/registry";
import type { Tool } from "@/domain/tools/types";
import {
  isTypedToolError,
  type JSONSchema,
  type ToolContext,
  type ToolInvocationLog,
  type ToolResult,
} from "@/domain/tools/types";
import Ajv, { type ValidateFunction as AjvValidateFunction } from "ajv";

// ---------------------------------------------------------------------------
// IToolExecutor port interface
// ---------------------------------------------------------------------------

export interface ToolExecutorConfig {
  readonly defaultTimeoutMs: number;
  readonly logMaxInputBytes: number;
}

export interface IToolExecutor {
  invoke(
    name: string,
    rawInput: unknown,
    context: ToolContext,
  ): Promise<ToolResult<unknown>>;
}

// ---------------------------------------------------------------------------
// ToolExecutor implementation
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full tool invocation pipeline:
 * registry lookup → permission check → input validation → execute with timeout
 * → output validation → structured log emission.
 *
 * - Never throws; all error paths return ToolResult { ok: false }.
 * - ajv schema compilation is cached per tool name (first-use compile, then reuse).
 * - Input summary is sanitized (truncated to logMaxInputBytes) before logging.
 */
export class ToolExecutor implements IToolExecutor {
  readonly #registry: IToolRegistry;
  readonly #permissions: IPermissionSystem;
  readonly #config: ToolExecutorConfig;
  readonly #ajv: Ajv;
  /** Compiled validators keyed by "toolName:input" or "toolName:output". */
  readonly #validatorCache = new Map<string, AjvValidateFunction>();

  constructor(
    registry: IToolRegistry,
    permissions: IPermissionSystem,
    config: ToolExecutorConfig,
  ) {
    this.#registry = registry;
    this.#permissions = permissions;
    this.#config = config;
    this.#ajv = new Ajv({ allErrors: false, strict: false });
  }

  /** Returns number of compiled validators in cache (for testing/observability). */
  compiledValidatorCount(): number {
    return this.#validatorCache.size;
  }

  async invoke(
    name: string,
    rawInput: unknown,
    context: ToolContext,
  ): Promise<ToolResult<unknown>> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    // 1. Registry lookup
    const registryResult = this.#registry.get(name);
    if (!registryResult.ok) {
      const durationMs = Date.now() - startMs;
      context.logger.error(this.#buildLog(name, rawInput, startedAt, durationMs, "permission", "Tool not found"));
      return {
        ok: false,
        error: { type: "permission", message: `Tool not found: ${name}` },
      };
    }
    const tool = registryResult.value;

    // 2. Permission check
    const permCheck = this.#permissions.checkPermissions(
      tool.requiredPermissions,
      context.permissions,
    );
    if (!permCheck.granted) {
      const durationMs = Date.now() - startMs;
      const message = `Permission denied for tool '${name}': missing flags [${permCheck.missingFlags.join(", ")}]`;
      context.logger.error(this.#buildLog(name, rawInput, startedAt, durationMs, "permission", message));
      return {
        ok: false,
        error: { type: "permission", message, details: { missingFlags: permCheck.missingFlags } },
      };
    }

    // 3. Input schema validation
    const inputValidator = this.#getValidator(`${name}:input`, tool.schema.input);
    const inputErrors = this.#runValidation(inputValidator, rawInput);
    if (inputErrors !== null) {
      const durationMs = Date.now() - startMs;
      const message = `Input validation failed for tool '${name}': ${inputErrors}`;
      context.logger.error(this.#buildLog(name, rawInput, startedAt, durationMs, "validation", message));
      return {
        ok: false,
        error: { type: "validation", message, details: { ajvErrors: inputErrors } },
      };
    }

    // 4. Execute with timeout race
    const timeoutMs = tool.timeoutMs ?? this.#config.defaultTimeoutMs;
    let rawOutput: unknown;
    try {
      rawOutput = await this.#executeWithTimeout(tool, rawInput, context, timeoutMs);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      if (err instanceof TimeoutError) {
        const message = `Tool '${name}' timed out after ${timeoutMs}ms`;
        context.logger.error(this.#buildLog(name, rawInput, startedAt, durationMs, "runtime", message));
        return {
          ok: false,
          error: { type: "runtime", message, details: { timeoutMs, toolName: name } },
        };
      }
      const originalMessage = err instanceof Error ? err.message : String(err);
      const errorType = isTypedToolError(err) ? err.toolErrorType : "runtime";
      const message = `Tool '${name}' threw an unhandled exception: ${originalMessage}`;
      context.logger.error(this.#buildLog(name, rawInput, startedAt, durationMs, errorType, message));
      return {
        ok: false,
        error: { type: errorType, message, details: { originalMessage } },
      };
    }

    // 5. Output schema validation
    const outputValidator = this.#getValidator(`${name}:output`, tool.schema.output);
    const outputErrors = this.#runValidation(outputValidator, rawOutput);
    if (outputErrors !== null) {
      const durationMs = Date.now() - startMs;
      const message = `Output validation failed for tool '${name}': ${outputErrors}`;
      context.logger.error(this.#buildLog(name, rawInput, startedAt, durationMs, "validation", message));
      return {
        ok: false,
        error: { type: "validation", message, details: { ajvErrors: outputErrors } },
      };
    }

    // 6. Success — emit log and return
    const durationMs = Date.now() - startMs;
    const outputSize = this.#computeOutputSize(rawOutput);
    context.logger.info(this.#buildLog(name, rawInput, startedAt, durationMs, "success", undefined, outputSize));
    return { ok: true, value: rawOutput };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  #getValidator(cacheKey: string, schema: JSONSchema): AjvValidateFunction {
    const cached = this.#validatorCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const compiled = this.#ajv.compile(schema);
    this.#validatorCache.set(cacheKey, compiled);
    return compiled;
  }

  /** Runs the compiled validator and returns formatted error text, or null on success. */
  #runValidation(validator: AjvValidateFunction, data: unknown): string | null {
    if (validator(data)) return null;
    return this.#ajv.errorsText(validator.errors);
  }

  async #executeWithTimeout(
    tool: Tool<unknown, unknown>,
    input: unknown,
    context: ToolContext,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const executionPromise = tool.execute(input, context);
    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new TimeoutError(`Tool '${tool.name}' timed out after ${timeoutMs}ms`));
      });
    });

    try {
      return await Promise.race([executionPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  #sanitizeInput(rawInput: unknown, maxBytes: number): string {
    try {
      const json = JSON.stringify(rawInput) ?? "null";
      if (json.length <= maxBytes) return json;
      return json.slice(0, maxBytes);
    } catch {
      return "[unserializable]";
    }
  }

  #computeOutputSize(output: unknown): number {
    if (Array.isArray(output)) return output.length;
    try {
      return (JSON.stringify(output) ?? "").length;
    } catch {
      return 0;
    }
  }

  #buildLog(
    toolName: string,
    rawInput: unknown,
    startedAt: string,
    durationMs: number,
    resultStatus: ToolInvocationLog["resultStatus"],
    errorMessage?: string,
    outputSize?: number,
  ): ToolInvocationLog {
    const inputSummary = this.#sanitizeInput(rawInput, this.#config.logMaxInputBytes);
    return {
      toolName,
      inputSummary,
      startedAt,
      durationMs,
      resultStatus,
      ...(outputSize !== undefined ? { outputSize } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Internal error types and helpers
// ---------------------------------------------------------------------------

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
