import type { ExecutionMode, PermissionFlag, PermissionSet } from "./types";

// ---------------------------------------------------------------------------
// PermissionCheck result type
// ---------------------------------------------------------------------------

export interface PermissionCheck {
  readonly granted: boolean;
  readonly missingFlags: ReadonlyArray<PermissionFlag>;
}

// ---------------------------------------------------------------------------
// IPermissionSystem port interface
// ---------------------------------------------------------------------------

export interface IPermissionSystem {
  resolvePermissionSet(mode: ExecutionMode): PermissionSet;
  checkPermissions(
    required: ReadonlyArray<PermissionFlag>,
    active: PermissionSet,
  ): PermissionCheck;
}

// ---------------------------------------------------------------------------
// Compile-time mode profiles (frozen, immutable)
// ---------------------------------------------------------------------------

const MODE_PROFILES: Readonly<Record<ExecutionMode, PermissionSet>> = Object.freeze({
  ReadOnly: Object.freeze({
    filesystemRead: true,
    filesystemWrite: false,
    shellExecution: false,
    gitWrite: false,
    networkAccess: false,
  }),
  Dev: Object.freeze({
    filesystemRead: true,
    filesystemWrite: true,
    shellExecution: false,
    gitWrite: false,
    networkAccess: false,
  }),
  CI: Object.freeze({
    filesystemRead: true,
    filesystemWrite: false,
    shellExecution: true,
    gitWrite: false,
    networkAccess: false,
  }),
  Full: Object.freeze({
    filesystemRead: true,
    filesystemWrite: true,
    shellExecution: true,
    gitWrite: true,
    networkAccess: true,
  }),
});

// ---------------------------------------------------------------------------
// PermissionSystem implementation
// ---------------------------------------------------------------------------

/**
 * Resolves execution modes to frozen PermissionSet profiles and checks
 * whether a tool's required permissions are satisfied by the active set.
 *
 * Mode profiles are compile-time constants; runtime modification is impossible.
 */
export class PermissionSystem implements IPermissionSystem {
  resolvePermissionSet(mode: ExecutionMode): PermissionSet {
    return MODE_PROFILES[mode];
  }

  checkPermissions(
    required: ReadonlyArray<PermissionFlag>,
    active: PermissionSet,
  ): PermissionCheck {
    const missingFlags = required.filter((flag) => !active[flag]);
    return {
      granted: missingFlags.length === 0,
      missingFlags,
    };
  }
}
