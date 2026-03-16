import type { ApprovalRequest } from "@/domain/safety/guards";
import { CliApprovalGateway } from "@/infra/safety/approval-gateway";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    description: "Bulk deletion of 15 files",
    riskClassification: "high",
    expectedImpact: "Permanently deletes 15 files from the workspace",
    proposedAction: "delete_files with 15 paths",
    ...overrides,
  };
}

type ReadlineFactory = (question: string, timeoutMs: number) => Promise<string>;

// ---------------------------------------------------------------------------
// CliApprovalGateway tests
// ---------------------------------------------------------------------------

describe("CliApprovalGateway", () => {
  describe("requestApproval()", () => {
    it("returns \"approved\" when user types \"y\"", async () => {
      const factory: ReadlineFactory = async () => "y";
      const gw = new CliApprovalGateway(factory);

      const result = await gw.requestApproval(makeRequest(), 5_000);
      expect(result).toBe("approved");
    });

    it("returns \"approved\" when user types \"Y\" (case-insensitive)", async () => {
      const factory: ReadlineFactory = async () => "Y";
      const gw = new CliApprovalGateway(factory);

      const result = await gw.requestApproval(makeRequest(), 5_000);
      expect(result).toBe("approved");
    });

    it("returns \"approved\" when user types \"yes\" (case-insensitive)", async () => {
      const factory: ReadlineFactory = async () => "yes";
      const gw = new CliApprovalGateway(factory);

      const result = await gw.requestApproval(makeRequest(), 5_000);
      expect(result).toBe("approved");
    });

    it("returns \"denied\" when user types \"n\"", async () => {
      const factory: ReadlineFactory = async () => "n";
      const gw = new CliApprovalGateway(factory);

      const result = await gw.requestApproval(makeRequest(), 5_000);
      expect(result).toBe("denied");
    });

    it("returns \"denied\" when user types \"no\"", async () => {
      const factory: ReadlineFactory = async () => "no";
      const gw = new CliApprovalGateway(factory);

      const result = await gw.requestApproval(makeRequest(), 5_000);
      expect(result).toBe("denied");
    });

    it("returns \"denied\" for any unrecognized input", async () => {
      const factory: ReadlineFactory = async () => "maybe";
      const gw = new CliApprovalGateway(factory);

      const result = await gw.requestApproval(makeRequest(), 5_000);
      expect(result).toBe("denied");
    });

    it("returns \"denied\" for empty input", async () => {
      const factory: ReadlineFactory = async () => "";
      const gw = new CliApprovalGateway(factory);

      const result = await gw.requestApproval(makeRequest(), 5_000);
      expect(result).toBe("denied");
    });

    it("returns \"timeout\" when the readline factory rejects with a timeout error", async () => {
      const factory: ReadlineFactory = async (_question, _timeoutMs) => {
        throw new Error("timeout");
      };
      const gw = new CliApprovalGateway(factory);

      const result = await gw.requestApproval(makeRequest(), 100);
      expect(result).toBe("timeout");
    });

    it("returns \"timeout\" when the readline factory rejects with an AbortError", async () => {
      const factory: ReadlineFactory = async () => {
        const err = new Error("The operation was aborted");
        (err as NodeJS.ErrnoException).code = "ABORT_ERR";
        throw err;
      };
      const gw = new CliApprovalGateway(factory);

      const result = await gw.requestApproval(makeRequest(), 100);
      expect(result).toBe("timeout");
    });

    it("never throws; returns \"denied\" when factory throws an unexpected error", async () => {
      const factory: ReadlineFactory = async () => {
        throw new Error("unexpected readline failure");
      };
      // Non-timeout errors should still not propagate
      const gw = new CliApprovalGateway(factory);

      // Should not throw
      const result = await gw.requestApproval(makeRequest(), 5_000);
      // Any rejection should resolve as denied (or timeout — implementation decides)
      expect(["denied", "timeout"]).toContain(result);
    });

    it("includes request description in the prompt string passed to readline factory", async () => {
      let capturedQuestion = "";
      const factory: ReadlineFactory = async (question) => {
        capturedQuestion = question;
        return "n";
      };
      const gw = new CliApprovalGateway(factory);

      await gw.requestApproval(makeRequest({ description: "Force-push to remote" }), 5_000);
      expect(capturedQuestion).toContain("Force-push to remote");
    });

    it("includes risk classification in the prompt string", async () => {
      let capturedQuestion = "";
      const factory: ReadlineFactory = async (question) => {
        capturedQuestion = question;
        return "n";
      };
      const gw = new CliApprovalGateway(factory);

      await gw.requestApproval(makeRequest({ riskClassification: "critical" }), 5_000);
      expect(capturedQuestion).toContain("critical");
    });

    it("passes the timeoutMs to the readline factory", async () => {
      let capturedTimeout = 0;
      const factory: ReadlineFactory = async (_question, timeoutMs) => {
        capturedTimeout = timeoutMs;
        return "y";
      };
      const gw = new CliApprovalGateway(factory);

      await gw.requestApproval(makeRequest(), 12_345);
      expect(capturedTimeout).toBe(12_345);
    });
  });
});
