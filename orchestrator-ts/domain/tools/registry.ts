import type { Tool } from './types';

// ---------------------------------------------------------------------------
// RegistryError discriminated union
// ---------------------------------------------------------------------------

export type RegistryError =
  | { readonly type: 'duplicate_name'; readonly name: string }
  | { readonly type: 'not_found';      readonly name: string };

// ---------------------------------------------------------------------------
// RegistryResult discriminated union
// ---------------------------------------------------------------------------

export type RegistryResult<T> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly error: RegistryError };

// ---------------------------------------------------------------------------
// IToolRegistry port interface
// ---------------------------------------------------------------------------

export type ToolListEntry = {
  readonly name: string;
  readonly description: string;
  readonly schema: Tool<unknown, unknown>['schema'];
};

export interface IToolRegistry {
  register(tool: Tool<unknown, unknown>): RegistryResult<void>;
  get(name: string): RegistryResult<Tool<unknown, unknown>>;
  list(): ReadonlyArray<ToolListEntry>;
}

// ---------------------------------------------------------------------------
// ToolRegistry implementation
// ---------------------------------------------------------------------------

/**
 * Central in-memory tool registry.
 * - Append-only: no deletion or overwrite.
 * - Rejects duplicate names with a typed error; never silently overwrites.
 * - Returns typed not_found results; never throws.
 */
export class ToolRegistry implements IToolRegistry {
  readonly #tools = new Map<string, Tool<unknown, unknown>>();

  register(tool: Tool<unknown, unknown>): RegistryResult<void> {
    if (this.#tools.has(tool.name)) {
      return { ok: false, error: { type: 'duplicate_name', name: tool.name } };
    }
    this.#tools.set(tool.name, tool);
    return { ok: true, value: undefined };
  }

  get(name: string): RegistryResult<Tool<unknown, unknown>> {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      return { ok: false, error: { type: 'not_found', name } };
    }
    return { ok: true, value: tool };
  }

  list(): ReadonlyArray<ToolListEntry> {
    return Array.from(this.#tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
    }));
  }
}
