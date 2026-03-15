import type { DebugEvent } from "@/domain/debug/types";

/**
 * Fan-in interface for all debug events emitted from MockLlmProvider,
 * DebugApprovalGate, and DebugAgentEventBus.
 *
 * Contracts:
 * - `emit()` is always safe to call; no initialization required.
 * - `close()` flushes all buffered entries and releases file handles.
 * - Calls to `emit()` after `close()` are silently dropped.
 * - Implementations must never throw from `emit()` or `close()`.
 */
export interface IDebugEventSink {
  emit(event: DebugEvent): void;
  close(): Promise<void>;
}
