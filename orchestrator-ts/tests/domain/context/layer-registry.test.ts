/**
 * Unit tests for domain/context/layer-registry.ts (Task 2)
 * TDD: tests written before implementation.
 */
import { describe, expect, it } from "bun:test";
import type { LayerId } from "../../../src/application/ports/context";
import {
  getLayerByIndex,
  getLayerEntry,
  getLayersInOrder,
  LAYER_REGISTRY,
} from "../../../src/domain/context/layer-registry";

describe("LayerRegistry", () => {
  describe("LAYER_REGISTRY constant", () => {
    it("contains exactly seven layers", () => {
      expect(LAYER_REGISTRY.length).toBe(7);
    });

    it("is frozen (immutable)", () => {
      expect(Object.isFrozen(LAYER_REGISTRY)).toBe(true);
    });

    it("has canonical order: systemInstructions, taskDescription, activeSpecification, codeContext, repositoryState, memoryRetrieval, toolResults", () => {
      const ids = LAYER_REGISTRY.map((l) => l.id);
      expect(ids).toEqual([
        "systemInstructions",
        "taskDescription",
        "activeSpecification",
        "codeContext",
        "repositoryState",
        "memoryRetrieval",
        "toolResults",
      ]);
    });

    it("each entry has id, defaultBudget, cacheable, and compressible fields", () => {
      for (const entry of LAYER_REGISTRY) {
        expect(typeof entry.id).toBe("string");
        expect(typeof entry.defaultBudget).toBe("number");
        expect(typeof entry.cacheable).toBe("boolean");
        expect(typeof entry.compressible).toBe("boolean");
      }
    });

    it("each layer has the correct default budget", () => {
      const expected: Record<LayerId, number> = {
        systemInstructions: 1000,
        taskDescription: 500,
        activeSpecification: 2000,
        codeContext: 4000,
        repositoryState: 500,
        memoryRetrieval: 1500,
        toolResults: 2000,
      };
      for (const [id, budget] of Object.entries(expected) as [LayerId, number][]) {
        expect(getLayerEntry(id)?.defaultBudget).toBe(budget);
      }
    });

    it("each layer has the correct compressible flag", () => {
      const expected: Record<LayerId, boolean> = {
        systemInstructions: false,
        taskDescription: false,
        activeSpecification: true,
        codeContext: true,
        repositoryState: false,
        memoryRetrieval: true,
        toolResults: false,
      };
      for (const [id, compressible] of Object.entries(expected) as [LayerId, boolean][]) {
        expect(getLayerEntry(id)?.compressible).toBe(compressible);
      }
    });

    it("each layer has the correct cacheable flag", () => {
      const expected: Record<LayerId, boolean> = {
        systemInstructions: true,
        taskDescription: false,
        activeSpecification: false,
        codeContext: false,
        repositoryState: false,
        memoryRetrieval: false,
        toolResults: false,
      };
      for (const [id, cacheable] of Object.entries(expected) as [LayerId, boolean][]) {
        expect(getLayerEntry(id)?.cacheable).toBe(cacheable);
      }
    });
  });

  describe("getLayersInOrder()", () => {
    it("returns all seven layers in canonical order", () => {
      const layers = getLayersInOrder();
      expect(layers.length).toBe(7);
      expect(layers[0].id).toBe("systemInstructions");
      expect(layers[6].id).toBe("toolResults");
    });

    it("returns a new array (not the original frozen constant)", () => {
      const a = getLayersInOrder();
      const b = getLayersInOrder();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe("getLayerEntry()", () => {
    it("returns the correct entry for a valid LayerId", () => {
      const entry = getLayerEntry("codeContext");
      expect(entry?.id).toBe("codeContext");
      expect(entry?.defaultBudget).toBe(4000);
    });

    it("returns undefined for an unknown id", () => {
      const entry = getLayerEntry("unknown" as LayerId);
      expect(entry).toBeUndefined();
    });

    it("returns correct entry for each of the seven layers", () => {
      const ids: LayerId[] = [
        "systemInstructions",
        "taskDescription",
        "activeSpecification",
        "codeContext",
        "repositoryState",
        "memoryRetrieval",
        "toolResults",
      ];
      for (const id of ids) {
        expect(getLayerEntry(id)?.id).toBe(id);
      }
    });
  });

  describe("getLayerByIndex()", () => {
    it("returns the layer at position 0 (systemInstructions)", () => {
      expect(getLayerByIndex(0)?.id).toBe("systemInstructions");
    });

    it("returns the layer at position 6 (toolResults)", () => {
      expect(getLayerByIndex(6)?.id).toBe("toolResults");
    });

    it("returns undefined for out-of-range index", () => {
      expect(getLayerByIndex(7)).toBeUndefined();
      expect(getLayerByIndex(-1)).toBeUndefined();
    });
  });

  describe("Ordering invariants", () => {
    it("systemInstructions index < taskDescription index", () => {
      const siIdx = LAYER_REGISTRY.findIndex((l) => l.id === "systemInstructions");
      const tdIdx = LAYER_REGISTRY.findIndex((l) => l.id === "taskDescription");
      expect(siIdx).toBeLessThan(tdIdx);
    });

    it("toolResults is at the last index", () => {
      const trIdx = LAYER_REGISTRY.findIndex((l) => l.id === "toolResults");
      expect(trIdx).toBe(LAYER_REGISTRY.length - 1);
    });

    it("systemInstructions is at index 0", () => {
      expect(LAYER_REGISTRY.findIndex((l) => l.id === "systemInstructions")).toBe(0);
    });
  });
});
