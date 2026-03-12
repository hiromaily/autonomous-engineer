import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowState } from "../../domain/workflow/types";
import { WorkflowStateStore } from "../../infra/state/workflow-state-store";

describe("WorkflowStateStore", () => {
  let tmpDir: string;
  let store: WorkflowStateStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-state-test-"));
    store = new WorkflowStateStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("init()", () => {
    it("returns a fresh running state for the given specName", () => {
      const state = store.init("my-feature");

      expect(state.specName).toBe("my-feature");
      expect(state.currentPhase).toBe("SPEC_INIT");
      expect(state.completedPhases).toHaveLength(0);
      expect(state.status).toBe("running");
      expect(state.failureDetail).toBeUndefined();
    });

    it("sets startedAt and updatedAt to ISO 8601 timestamps", () => {
      const before = new Date().toISOString();
      const state = store.init("my-feature");
      const after = new Date().toISOString();

      expect(state.startedAt >= before).toBe(true);
      expect(state.startedAt <= after).toBe(true);
      expect(state.updatedAt).toBe(state.startedAt);
    });

    it("does not write anything to disk", async () => {
      store.init("my-feature");

      const restored = await store.restore("my-feature");
      expect(restored).toBeNull();
    });
  });

  describe("persist() and restore()", () => {
    it("persists state and restores it correctly", async () => {
      const state = store.init("my-feature");
      await store.persist(state);

      const restored = await store.restore("my-feature");

      expect(restored).not.toBeNull();
      expect(restored?.specName).toBe("my-feature");
      expect(restored?.currentPhase).toBe("SPEC_INIT");
      expect(restored?.status).toBe("running");
    });

    it("stores state as valid JSON at .aes/state/<specName>.json", async () => {
      const state = store.init("my-feature");
      await store.persist(state);

      const raw = await readFile(join(tmpDir, ".aes", "state", "my-feature.json"), "utf-8");
      const parsed = JSON.parse(raw) as WorkflowState;

      expect(parsed.specName).toBe("my-feature");
    });

    it("creates the .aes/state/ directory if it does not exist", async () => {
      const state = store.init("new-spec");
      await store.persist(state);

      const restored = await store.restore("new-spec");
      expect(restored).not.toBeNull();
    });

    it("overwrites previous state on subsequent persists", async () => {
      const initial = store.init("my-feature");
      await store.persist(initial);

      const updated: WorkflowState = {
        ...initial,
        currentPhase: "REQUIREMENTS",
        completedPhases: ["SPEC_INIT"],
        status: "paused_for_approval",
        updatedAt: new Date().toISOString(),
      };
      await store.persist(updated);

      const restored = await store.restore("my-feature");
      expect(restored?.currentPhase).toBe("REQUIREMENTS");
      expect(restored?.status).toBe("paused_for_approval");
    });

    it("stores and restores state with failureDetail", async () => {
      const state: WorkflowState = {
        ...store.init("my-feature"),
        currentPhase: "DESIGN",
        completedPhases: ["SPEC_INIT", "REQUIREMENTS"],
        status: "failed",
        failureDetail: { phase: "DESIGN", error: "LLM API error" },
      };
      await store.persist(state);

      const restored = await store.restore("my-feature");
      expect(restored?.failureDetail?.phase).toBe("DESIGN");
      expect(restored?.failureDetail?.error).toBe("LLM API error");
    });

    it("isolates state files per specName", async () => {
      const stateA = store.init("spec-a");
      const stateB: WorkflowState = {
        ...store.init("spec-b"),
        currentPhase: "REQUIREMENTS",
        completedPhases: ["SPEC_INIT"],
        updatedAt: new Date().toISOString(),
      };

      await store.persist(stateA);
      await store.persist(stateB);

      const restoredA = await store.restore("spec-a");
      const restoredB = await store.restore("spec-b");

      expect(restoredA?.currentPhase).toBe("SPEC_INIT");
      expect(restoredB?.currentPhase).toBe("REQUIREMENTS");
    });
  });

  describe("restore()", () => {
    it("returns null when no state file exists", async () => {
      const result = await store.restore("nonexistent");
      expect(result).toBeNull();
    });

    it("throws on malformed JSON in the state file", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const stateDir = join(tmpDir, ".aes", "state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, "bad.json"), "{ not valid json }");

      await expect(store.restore("bad")).rejects.toThrow();
    });
  });
});
