---
paths:
  - "orchestrator-ts/src/main/**/*.ts"
---

# Dependency Injection

## Overview

Rules for the DI layer in `orchestrator-ts`.
The `src/main/` directory is the composition root — it is the only place
that wires together all architectural layers.

## Applicable Files

- `orchestrator-ts/src/main/*-container.ts` — DI container classes
- `orchestrator-ts/src/main/index.ts` — entry point that calls containers

## Core Principles

### 1. Pure Constructor Pattern (Mandatory)

Constructors must only **receive and store** dependencies. No object creation inside constructors.

```typescript
// ✅ GOOD: Pure constructor — just stores what is passed in
export class RunContainer {
  constructor(
    private readonly config: AesConfig,
    private readonly options: RunOptions,
  ) {}
}

// ❌ BAD: Constructor creates internal objects
export class RunContainer {
  constructor(config: AesConfig, options: RunOptions) {
    this.eventBus = new WorkflowEventBus(); // DON'T create dependencies here
    this.useCase = new RunSpecUseCase(...);
  }
}
```

### 2. Lazy Initialization with Caching

Expensive dependencies are created on first access and cached for reuse.
Use a private backing field initialised to `undefined`; check it in the getter.

```typescript
// ✅ GOOD: Lazy getter with caching
private _eventBus?: WorkflowEventBus;

private get eventBus(): WorkflowEventBus {
  if (!this._eventBus) {
    this._eventBus = new WorkflowEventBus();
  }
  return this._eventBus;
}

// ❌ BAD: No caching — creates a new instance every time
private get eventBus(): WorkflowEventBus {
  return new WorkflowEventBus();
}
```

For nullable resources (those that may be absent based on options), use
`undefined` as the sentinel and `null` as the explicit "not present" value:

```typescript
private _logWriter?: IJsonLogWriter | null; // undefined = not yet evaluated

private get logWriter(): IJsonLogWriter | null {
  if (this._logWriter === undefined) {
    this._logWriter = this.options.logJsonPath !== undefined
      ? new JsonLogWriter(this.options.logJsonPath)
      : null;
  }
  return this._logWriter;
}
```

### 3. No Factory Pattern for Application/Domain Objects

Use direct constructor calls from the container. Factory functions add
unnecessary indirection for objects whose type is determined at wiring time.

```typescript
// ✅ GOOD: Direct constructor call in the container
private get useCase(): RunSpecUseCase {
  if (!this._useCase) {
    this._useCase = new RunSpecUseCase({ ... });
  }
  return this._useCase;
}

// ❌ BAD: Factory indirection
private get useCase(): RunSpecUseCase {
  return useCaseFactory.createRunSpecUseCase(this.config);
}
```

**Exception:** Factory methods (`new*()`) are acceptable for resources that
must NOT be cached because different callers need distinct instances (e.g.
`LlmProviderPort`, which varies per `providerOverride`):

```typescript
// ✅ GOOD: Non-cached factory method for per-call variation
private newLlmProvider(providerOverride?: string): LlmProviderPort {
  const provider = providerOverride ?? this.config.llm.provider;
  switch (provider) {
    case "claude":
      return new ClaudeProvider({ ... });
    default:
      throw new Error(`Unsupported LLM provider: '${provider}'`);
  }
}
```

### 4. Interface-Based Dependencies

Containers depend on port interfaces, not concrete implementations, wherever a
port exists. Concrete types are used only in the private backing fields.

```typescript
// ✅ GOOD: Backing field typed to interface; concrete type used only at construction
private _logWriter?: IJsonLogWriter | null;

private get logWriter(): IJsonLogWriter | null { ... }
```

### 5. Single `build()` Method for Side-Effects

Side-effects that connect components (e.g. registering event-bus listeners)
must NOT happen inside lazy getters. They belong in the public `build()`
method, which is called exactly once per container instance.

```typescript
// ✅ GOOD: Side-effects isolated to build()
build(): RunDependencies {
  const logWriter = this.logWriter;
  if (logWriter !== null) {
    this.eventBus.on((event) => {
      logWriter.write(event).catch(...);
    });
  }
  return { useCase: this.useCase, eventBus: this.eventBus, ... };
}

// ❌ BAD: Side-effect buried in a lazy getter
private get useCase(): RunSpecUseCase {
  if (!this._useCase) {
    this.eventBus.on(...); // side-effect in getter — hard to reason about
    this._useCase = new RunSpecUseCase(...);
  }
  return this._useCase;
}
```

## Container Responsibilities

Each container class (`*Container`) in `src/main/` must:

1. **Hold configuration** — store the config/options passed to the constructor
2. **Wire dependencies** — lazily create and connect all objects
3. **Manage lifecycle** — cache singleton-like instances
4. **Handle branching** — switch between implementations based on options (e.g. `debugFlow`)

```typescript
// ✅ GOOD: Mode-switching in the container
private get sdd(): SddFrameworkPort {
  if (!this._sdd) {
    this._sdd = this.options.debugFlow
      ? new MockSddAdapter(this.debugWriter ?? undefined)
      : new CcSddAdapter();
  }
  return this._sdd;
}
```

## Naming Conventions

| Pattern                  | Convention                  | Example                        |
| ------------------------ | --------------------------- | ------------------------------ |
| Container class          | `*Container`                | `RunContainer`                 |
| Container file           | `*-container.ts`            | `run-container.ts`             |
| Cached backing field     | `_` + camelCase             | `_eventBus`, `_useCase`        |
| Lazy cached getter       | `private get` + camelCase   | `get eventBus()`, `get memory()` |
| Non-cached factory method | `new` + PascalCase          | `newLlmProvider()`             |
| Public assembly method   | `build()`                   | `build(): RunDependencies`     |

## Dependency Flow

```
src/main/index.ts
  └── new RunContainer(config, options).build()
        └── RunSpecUseCase (application/usecases/)
              └── with ports from application/ports/
                    └── implemented by infra/ and adapters/
```

All dependency arrows point **inward** toward the domain layer.
Only `src/main/` is permitted to cross all layer boundaries.

## Anti-Patterns to Avoid

| Anti-Pattern                        | Why It's Bad                                     | Alternative                          |
| ----------------------------------- | ------------------------------------------------ | ------------------------------------ |
| Logic in constructors               | Breaks testability; side-effects at init time    | Pure constructor + lazy getters      |
| Eager instantiation of all deps     | Wastes resources; couples unrelated dependencies | Lazy getters with caching            |
| Side-effects in lazy getters        | Execution order is implicit and fragile          | Isolate to `build()`                 |
| Caching non-deterministic factories | Stale instances when override varies per call    | Non-cached `new*()` factory methods  |
| Calling `build()` multiple times    | Event listeners registered multiple times        | Treat `build()` as a one-shot call   |

## Testing Implications

Pure constructors and lazy getters enable focused unit tests:

```typescript
// Test can create the container and inspect only the parts it cares about
it("returns null debugWriter when debugFlow is false", () => {
  const deps = new RunContainer(stubConfig, { debugFlow: false }).build();
  expect(deps.debugWriter).toBeNull();
});

// Containers are cheap to instantiate — no expensive work in constructor
it("returns a non-null debugWriter when debugFlow is true", () => {
  const deps = new RunContainer(stubConfig, { debugFlow: true }).build();
  expect(deps.debugWriter).not.toBeNull();
  deps.debugWriter?.close().catch(() => {});
});
```

## Related Rules

- @.claude/rules/architecture.md — layer boundaries and import restrictions
- @.claude/rules/typescript.md — TypeScript coding conventions
