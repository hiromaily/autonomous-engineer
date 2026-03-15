# Implementation Tasks: cli-option-debug-workflow

## Overview

Implementation of the `--debug-flow` CLI option that replaces real LLM calls with a deterministic mock, auto-approves workflow gates, and emits structured debug events.

---

## Task 1: Create DebugEvent Domain Types

- [x] 1.1 Create `src/domain/debug/types.ts` with `DebugEvent` discriminated union (llm:call, llm:error, agent:iteration, approval:auto)

## Task 2: Create IDebugEventSink Port

- [x] 2.1 Create `src/application/ports/debug.ts` with `IDebugEventSink` interface (`emit(event: DebugEvent): void`, `close(): Promise<void>`)

## Task 3: Implement DebugLogWriter

- [x] 3.1 Write unit tests for `DebugLogWriter` in `tests/cli/debug-log-writer.test.ts`
- [x] 3.2 Implement `src/cli/debug-log-writer.ts` — writes to stderr by default, NDJSON to file when path given, falls back to stderr on file-open error, queues writes in `emit()`, flushes in `close()`

## Task 4: Implement MockLlmProvider

- [x] 4.1 Write unit tests for `MockLlmProvider` in `tests/adapters/mock-llm-provider.test.ts`
- [x] 4.2 Implement `src/adapters/llm/mock-llm-provider.ts` — subscribes to workflow event bus for phase tracking, returns deterministic mock response, emits llm:call/llm:error events, increments callIndex monotonically, clearContext() resets conversation history only

## Task 5: Implement DebugApprovalGate

- [x] 5.1 Write unit tests for `DebugApprovalGate` in `tests/application/workflow/debug-approval-gate.test.ts`
- [x] 5.2 Implement `src/application/workflow/debug-approval-gate.ts` — extends ApprovalGate, always returns `{ approved: true }`, emits `approval:auto` event, never reads disk

## Task 6: Implement DebugAgentEventBus

- [x] 6.1 Write unit tests for `DebugAgentEventBus` in `tests/application/agent/debug-agent-event-bus.test.ts`
- [x] 6.2 Implement `src/application/agent/debug-agent-event-bus.ts` — implements IAgentEventBus, maps `iteration:complete` to `agent:iteration` debug event, forwards all events to registered on() handlers, off() unregisters correctly

## Task 7: Update ImplementationLoopOptions and Service

- [x] 7.1 Add optional `agentEventBus?: IAgentEventBus` field to `ImplementationLoopOptions` in `src/application/ports/implementation-loop.ts`
- [x] 7.2 Update `DEFAULT_OPTIONS` and `#executeSection` in `src/application/implementation-loop/implementation-loop-service.ts` to pass `agentEventBus` to each `agentLoop.run()` call

## Task 8: Update RunSpecUseCase for ApprovalGate Injection

- [x] 8.1 Add optional `approvalGate?: ApprovalGate` field to `RunSpecUseCaseDeps` in `src/application/usecases/run-spec.ts`
- [x] 8.2 Update `RunSpecUseCase.run()` to use injected `approvalGate` when present instead of constructing a new one

## Task 9: Wire --debug-flow in CLI

- [x] 9.1 Add `--debug-flow` (boolean) and `--debug-flow-log` (string) flags to `src/cli/index.ts`
- [x] 9.2 Implement debug-flow wiring: bypass apiKey validation, emit banner, instantiate DebugLogWriter/MockLlmProvider/DebugApprovalGate/DebugAgentEventBus, inject into use case, call debugWriter.close() in finally block
