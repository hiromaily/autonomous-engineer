---
paths: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
---

# TypeScript/JavaScript File Rules

## Overview

Rules for modifying TypeScript (`*.ts`, `*.tsx`) and JavaScript (`*.js`, `*.jsx`) files.

## Applicable Directories

| App              | Language              | Runtime | Path                     |
| ---------------- | --------------------- | ------- | ------------------------ |
| orchestrator-ts | TypeScript            | **Bun** | `orchestrator-ts/` |

## Verification Commands

**Navigate to app directory first:**

### orchestrator-ts (TypeScript + Bun)

```bash
cd orchestrator-ts
bun install           # Install dependencies (if needed) — run this first if lint/fmt commands fail
bun run lint          # Lint with Biome
bun run lint:fix      # Lint plus fix with Biome
bun run fmt           # Format with dprint (NOTE: formatter is dprint, not Biome; Biome's formatter is disabled in biome.json)
bun run fmt:check     # Format check only with dprint
bun run typecheck     # TypeScript type checking
bun run test          # Run tests with Bun
bun run aes           # Run application
bun run aes:dev       # Run application with hot reload
bun run build         # Build for production
```

> **DO NOT** use `npm`/`npx` commands - always use `bun`/`bunx` instead.
>
> **NOTE on tooling:** Two separate tools are used — **dprint** for formatting (`bun run fmt`) and **Biome** for linting only. Biome's formatter is intentionally disabled in `biome.json`. If any script fails with "command not found", run `bun install` first to ensure all dev dependencies (including `@biomejs/biome` and `dprint`) are installed.

## Command Summary

| App              | Lint              | Format           | Build           | Test                |
| ---------------- | ----------------- | ---------------- | --------------- | ------------------- |
| orchestrator-ts | `bun run lint:fix` | `bun run fmt` (dprint) | `bun run build` | `bun run test` |

> **NOTE on `lint:fix`:** The default `bun run lint:fix` only applies *safe* auto-fixes. To also apply *unsafe* auto-fixes (e.g. `useTemplate`, `useLiteralKeys`), run:
> ```bash
> bun run lint:fix -- --unsafe
> ```
> Run the default first, then `--unsafe` for the remainder. Warnings that cannot be auto-fixed (e.g. `noNonNullAssertion`) must be resolved manually — see the Code Style section below.

## Code Style

### TypeScript Best Practices

```typescript
// Good: Explicit types
function getBalance(address: string): Promise<number> {
  // ...
}

// Good: Async/await with error handling
async function fetchData(): Promise<Data> {
  try {
    const result = await api.call();
    return result;
  } catch (error) {
    throw new Error(`Failed to fetch data: ${error.message}`);
  }
}

// Avoid: any type (unless absolutely necessary)
// Bad: function process(data: any)
// Good: function process(data: TransactionData)
```

### Non-Null Assertions (`!`)

Biome enforces `noNonNullAssertion`. Because `tsconfig.json` also sets `noUncheckedIndexedAccess: true`, every array index access returns `T | undefined`, making `!` assertions common. Replace them with safe alternatives:

```typescript
// Array indexing — use a fallback
const x = line[0] ?? " ";
const name = parts[0] ?? "";

// Regex match groups — use a fallback
if (passMatch) passed = parseInt(passMatch[1] ?? "0", 10);

// Fields validated non-null just above — use type assertion in production code
// (after an explicit null check that throws)
provider: merged.provider as string,

// Test code — add a guard that also serves as a clear failure message
const log = logger.getLogs()[0];
if (!log) throw new Error("expected log entry");
expect(log.resultStatus).toBe("success");
```

### Critical Value Handling

Never use nullish coalescing (`??`) with empty string for critical values like secrets or keys.
Instead, throw an error to fail fast and prevent silent failures.

```typescript
// Bad: Silently returns empty string if seed is undefined
const secret = wallet.seed ?? "";

// Good: Fail fast with explicit error
if (!wallet.seed) {
  throw new Error("Failed to generate a wallet seed.");
}
const secret = wallet.seed;
```

### Module Exports

Prefer named exports over default exports for consistency and better tooling support.

```typescript
// Bad: Mixed exports cause inconsistent import styles
export const myService = { ... };
export default myService;

// Good: Named exports only
export const myService = { ... };
```

### Import Order

1. Node.js built-ins
2. External packages
3. Internal modules

```typescript
import * as path from "path";

import { createConnectRouter } from "@connectrpc/connect";

import { AccountService } from "./services/account";
```

## Security

- No hardcoded secrets or API keys
- No sensitive data in logs
- Input validation at boundaries
- Use environment variables for configuration

## Quick Checklist

### orchestrator-ts

- [ ] `bun run lint:fix` passes
- [ ] `bun run fmt` applied
- [ ] `bun run typecheck` passes
- [ ] `bun run build` passes
- [ ] No `any` types (unless documented reason)
- [ ] Async errors properly handled
