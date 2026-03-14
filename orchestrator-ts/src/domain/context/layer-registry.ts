import type { LayerId } from "@/application/ports/context";

export interface LayerEntry {
  readonly id: LayerId;
  readonly defaultBudget: number;
  readonly cacheable: boolean;
  readonly compressible: boolean;
}

/**
 * Canonical ordered registry of all seven context layers.
 *
 * Invariants enforced by position:
 *   - systemInstructions is always at index 0
 *   - taskDescription is always at index 1
 *   - toolResults is always at index 6 (last)
 *
 * Default budgets match LayerBudgetConfig defaults from the port definition.
 * Compressible: only layers where content can be reduced without loss of essential signal.
 * Cacheable: only layers whose content is stable within a session (file-backed, mtime-invalidated).
 */
export const LAYER_REGISTRY: ReadonlyArray<LayerEntry> = Object.freeze([
  { id: "systemInstructions", defaultBudget: 1000, cacheable: true, compressible: false },
  { id: "taskDescription", defaultBudget: 500, cacheable: false, compressible: false },
  { id: "activeSpecification", defaultBudget: 2000, cacheable: false, compressible: true },
  { id: "codeContext", defaultBudget: 4000, cacheable: false, compressible: true },
  { id: "repositoryState", defaultBudget: 500, cacheable: false, compressible: false },
  { id: "memoryRetrieval", defaultBudget: 1500, cacheable: false, compressible: true },
  { id: "toolResults", defaultBudget: 2000, cacheable: false, compressible: false },
]);

/** Returns all layer entries in canonical order as a new array. */
export function getLayersInOrder(): LayerEntry[] {
  return [...LAYER_REGISTRY];
}

/** Returns the layer entry for the given LayerId, or undefined if not found. */
export function getLayerEntry(id: LayerId): LayerEntry | undefined {
  return LAYER_REGISTRY.find((l) => l.id === id);
}

/** Returns the layer entry at the given index, or undefined if out of range. */
export function getLayerByIndex(index: number): LayerEntry | undefined {
  return LAYER_REGISTRY[index];
}
