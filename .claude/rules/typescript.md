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
bun install           # Install dependencies (if needed)
bun run lint          # Lint with Biome
bun run lint:fix      # Lint plus fix with Biome
bun run fmt           # Format with Biome
bun run fmt:check.    # Format with Biome Check only
bun run typecheck     # TypeScript type checking
bun run test          # Run tests with Bun
bun run aes           # Run application
bun run aes:dev       # Run application with hot reload
bun run build         # Build for production
```

> **DO NOT** use `npm`/`npx` commands - always use `bun`/`bunx` instead.

## Command Summary

| App              | Lint              | Format           | Build           | Test                |
| ---------------- | ----------------- | ---------------- | --------------- | ------------------- |
| orchestrator-ts | `bun run lint:fix`    | `bun run fmt` | `bun run build` | `bun run test` |

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
