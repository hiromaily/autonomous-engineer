import { describe, expect, test } from "bun:test";
import { type IPermissionSystem, PermissionSystem } from "../../../domain/tools/permissions";
import type { ExecutionMode, PermissionFlag, PermissionSet } from "../../../domain/tools/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSystem(): IPermissionSystem {
  return new PermissionSystem();
}

// ---------------------------------------------------------------------------
// resolvePermissionSet — mode profiles
// ---------------------------------------------------------------------------

describe("PermissionSystem.resolvePermissionSet", () => {
  test("ReadOnly enables only filesystemRead", () => {
    const ps = makeSystem().resolvePermissionSet("ReadOnly");
    expect(ps.filesystemRead).toBe(true);
    expect(ps.filesystemWrite).toBe(false);
    expect(ps.shellExecution).toBe(false);
    expect(ps.gitWrite).toBe(false);
    expect(ps.networkAccess).toBe(false);
  });

  test("Dev enables filesystemRead and filesystemWrite only", () => {
    const ps = makeSystem().resolvePermissionSet("Dev");
    expect(ps.filesystemRead).toBe(true);
    expect(ps.filesystemWrite).toBe(true);
    expect(ps.shellExecution).toBe(false);
    expect(ps.gitWrite).toBe(false);
    expect(ps.networkAccess).toBe(false);
  });

  test("CI enables filesystemRead and shellExecution only", () => {
    const ps = makeSystem().resolvePermissionSet("CI");
    expect(ps.filesystemRead).toBe(true);
    expect(ps.filesystemWrite).toBe(false);
    expect(ps.shellExecution).toBe(true);
    expect(ps.gitWrite).toBe(false);
    expect(ps.networkAccess).toBe(false);
  });

  test("Full enables all flags", () => {
    const ps = makeSystem().resolvePermissionSet("Full");
    expect(ps.filesystemRead).toBe(true);
    expect(ps.filesystemWrite).toBe(true);
    expect(ps.shellExecution).toBe(true);
    expect(ps.gitWrite).toBe(true);
    expect(ps.networkAccess).toBe(true);
  });

  test("each mode returns a frozen (immutable) PermissionSet", () => {
    const modes: ExecutionMode[] = ["ReadOnly", "Dev", "CI", "Full"];
    const sys = makeSystem();
    for (const mode of modes) {
      const ps = sys.resolvePermissionSet(mode);
      expect(Object.isFrozen(ps)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// checkPermissions — grant / deny logic
// ---------------------------------------------------------------------------

describe("PermissionSystem.checkPermissions", () => {
  const sys = makeSystem();

  // Helper: build a PermissionSet with specific flags set to true
  function makePermissions(enabled: PermissionFlag[]): PermissionSet {
    return Object.freeze({
      filesystemRead: enabled.includes("filesystemRead"),
      filesystemWrite: enabled.includes("filesystemWrite"),
      shellExecution: enabled.includes("shellExecution"),
      gitWrite: enabled.includes("gitWrite"),
      networkAccess: enabled.includes("networkAccess"),
    });
  }

  test("grants when required list is empty", () => {
    const active = makePermissions([]);
    const result = sys.checkPermissions([], active);
    expect(result.granted).toBe(true);
    expect(result.missingFlags).toHaveLength(0);
  });

  test("grants when all required flags are present", () => {
    const active = makePermissions(["filesystemRead", "filesystemWrite"]);
    const result = sys.checkPermissions(["filesystemRead", "filesystemWrite"], active);
    expect(result.granted).toBe(true);
    expect(result.missingFlags).toHaveLength(0);
  });

  test("denies and lists missing flags when one flag is absent", () => {
    const active = makePermissions(["filesystemRead"]);
    const result = sys.checkPermissions(["filesystemRead", "filesystemWrite"], active);
    expect(result.granted).toBe(false);
    expect(result.missingFlags).toContain("filesystemWrite");
    expect(result.missingFlags).toHaveLength(1);
  });

  test("denies and lists all missing flags when multiple flags are absent", () => {
    const active = makePermissions(["filesystemRead"]);
    const result = sys.checkPermissions(
      ["filesystemRead", "shellExecution", "gitWrite"],
      active,
    );
    expect(result.granted).toBe(false);
    expect(result.missingFlags).toContain("shellExecution");
    expect(result.missingFlags).toContain("gitWrite");
    expect(result.missingFlags).toHaveLength(2);
  });

  test("denies when active set is completely empty", () => {
    const active = makePermissions([]);
    const result = sys.checkPermissions(["filesystemRead"], active);
    expect(result.granted).toBe(false);
    expect(result.missingFlags).toEqual(["filesystemRead"]);
  });

  test("Full mode permits shellExecution requirement", () => {
    const active = sys.resolvePermissionSet("Full");
    const result = sys.checkPermissions(["shellExecution"], active);
    expect(result.granted).toBe(true);
  });

  test("ReadOnly mode denies shellExecution requirement", () => {
    const active = sys.resolvePermissionSet("ReadOnly");
    const result = sys.checkPermissions(["shellExecution"], active);
    expect(result.granted).toBe(false);
    expect(result.missingFlags).toContain("shellExecution");
  });

  test("CI mode denies filesystemWrite requirement", () => {
    const active = sys.resolvePermissionSet("CI");
    const result = sys.checkPermissions(["filesystemWrite"], active);
    expect(result.granted).toBe(false);
    expect(result.missingFlags).toContain("filesystemWrite");
  });

  test("Dev mode denies gitWrite requirement", () => {
    const active = sys.resolvePermissionSet("Dev");
    const result = sys.checkPermissions(["gitWrite"], active);
    expect(result.granted).toBe(false);
    expect(result.missingFlags).toContain("gitWrite");
  });
});

// ---------------------------------------------------------------------------
// Type-level contract: IPermissionSystem is satisfied by PermissionSystem
// ---------------------------------------------------------------------------

describe("PermissionSystem type contract", () => {
  test("PermissionSystem satisfies IPermissionSystem interface", () => {
    const sys: IPermissionSystem = new PermissionSystem();
    expect(typeof sys.resolvePermissionSet).toBe("function");
    expect(typeof sys.checkPermissions).toBe("function");
  });
});
