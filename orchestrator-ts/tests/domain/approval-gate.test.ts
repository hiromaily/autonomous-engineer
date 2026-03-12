import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate, type ApprovalPhase } from "../../domain/workflow/approval-gate";

// ---------------------------------------------------------------------------
// Helper: write a minimal spec.json into a temp dir
// ---------------------------------------------------------------------------

async function writeSpecJson(dir: string, content: object): Promise<void> {
  await writeFile(join(dir, "spec.json"), JSON.stringify(content));
}

describe("ApprovalGate", () => {
  let specDir: string;
  let gate: ApprovalGate;

  beforeEach(async () => {
    specDir = await mkdtemp(join(tmpdir(), "aes-approval-test-"));
    gate = new ApprovalGate();
  });

  afterEach(async () => {
    await rm(specDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Approved path
  // -------------------------------------------------------------------------

  describe("approved: true", () => {
    it.each([
      ["requirements", { approvals: { requirements: { approved: true } } }],
      ["design", { approvals: { design: { approved: true } } }],
      ["tasks", { approvals: { tasks: { approved: true } } }],
    ] as [ApprovalPhase, object][])(
      "returns approved: true for phase \"%s\" when field is true",
      async (phase, content) => {
        await writeSpecJson(specDir, content);
        const result = await gate.check(specDir, phase);
        expect(result.approved).toBe(true);
      },
    );

    it("ignores other phases — only checks the requested one", async () => {
      await writeSpecJson(specDir, {
        approvals: {
          requirements: { approved: true },
          design: { approved: false },
          tasks: { approved: false },
        },
      });
      const result = await gate.check(specDir, "requirements");
      expect(result.approved).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Fail closed — missing file
  // -------------------------------------------------------------------------

  describe("fail closed — missing spec.json", () => {
    it("returns approved: false when spec.json does not exist", async () => {
      const result = await gate.check(specDir, "requirements");
      expect(result.approved).toBe(false);
    });

    it("includes instruction referencing spec.json when file is missing", async () => {
      const result = await gate.check(specDir, "requirements");
      expect(result.approved).toBe(false);
      if (!result.approved) {
        expect(result.instruction).toContain("spec.json");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Fail closed — malformed JSON
  // -------------------------------------------------------------------------

  describe("fail closed — malformed spec.json", () => {
    it("returns approved: false on invalid JSON", async () => {
      await writeFile(join(specDir, "spec.json"), "{ not valid json }");
      const result = await gate.check(specDir, "requirements");
      expect(result.approved).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Fail closed — approval field false or absent
  // -------------------------------------------------------------------------

  describe("fail closed — approval field false or absent", () => {
    it("returns approved: false when approval field is explicitly false", async () => {
      await writeSpecJson(specDir, { approvals: { requirements: { approved: false } } });
      const result = await gate.check(specDir, "requirements");
      expect(result.approved).toBe(false);
    });

    it("returns approved: false when approval field is absent", async () => {
      await writeSpecJson(specDir, { approvals: { requirements: {} } });
      const result = await gate.check(specDir, "requirements");
      expect(result.approved).toBe(false);
    });

    it("returns approved: false when approvals object is absent", async () => {
      await writeSpecJson(specDir, { phase: "requirements-generated" });
      const result = await gate.check(specDir, "requirements");
      expect(result.approved).toBe(false);
    });

    it("returns approved: false when phase key is absent in approvals", async () => {
      await writeSpecJson(specDir, { approvals: { design: { approved: true } } });
      const result = await gate.check(specDir, "requirements");
      expect(result.approved).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Pending result shape
  // -------------------------------------------------------------------------

  describe("pending result (approved: false)", () => {
    it("artifactPath points to requirements.md for requirements phase", async () => {
      const result = await gate.check(specDir, "requirements");
      expect(result.approved).toBe(false);
      if (!result.approved) {
        expect(result.artifactPath).toContain("requirements.md");
        expect(result.artifactPath.startsWith(specDir)).toBe(true);
      }
    });

    it("artifactPath points to design.md for design phase", async () => {
      const result = await gate.check(specDir, "design");
      expect(result.approved).toBe(false);
      if (!result.approved) expect(result.artifactPath).toContain("design.md");
    });

    it("artifactPath points to tasks.md for tasks phase", async () => {
      const result = await gate.check(specDir, "tasks");
      expect(result.approved).toBe(false);
      if (!result.approved) expect(result.artifactPath).toContain("tasks.md");
    });

    it("instruction names the approval field to set", async () => {
      const result = await gate.check(specDir, "requirements");
      expect(result.approved).toBe(false);
      if (!result.approved) {
        expect(result.instruction).toContain("approvals.requirements.approved");
      }
    });

    it("instruction for design names design approval field", async () => {
      await writeSpecJson(specDir, { approvals: { design: { approved: false } } });
      const result = await gate.check(specDir, "design");
      expect(result.approved).toBe(false);
      if (!result.approved) {
        expect(result.instruction).toContain("approvals.design.approved");
      }
    });

    it("instruction for tasks names tasks approval field", async () => {
      const result = await gate.check(specDir, "tasks");
      expect(result.approved).toBe(false);
      if (!result.approved) {
        expect(result.instruction).toContain("approvals.tasks.approved");
      }
    });
  });

  // -------------------------------------------------------------------------
  // No caching — reads spec.json fresh each call
  // -------------------------------------------------------------------------

  describe("no caching", () => {
    it("detects an approval written between two calls", async () => {
      await writeSpecJson(specDir, { approvals: { requirements: { approved: false } } });

      const first = await gate.check(specDir, "requirements");
      expect(first.approved).toBe(false);

      // Simulate out-of-process approval
      await writeSpecJson(specDir, { approvals: { requirements: { approved: true } } });

      const second = await gate.check(specDir, "requirements");
      expect(second.approved).toBe(true);
    });
  });
});
