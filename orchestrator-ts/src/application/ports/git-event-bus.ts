// ---------------------------------------------------------------------------
// IGitEventBus port — application/ports/git-event-bus.ts
//
// Port contract for the typed git event bus.
// No implementation code — interface definition only.
// ---------------------------------------------------------------------------

import type { GitEvent } from "../../domain/git/types";

/**
 * Port contract for the synchronous in-process git event bus.
 * Mirrors the IWorkflowEventBus pattern established in application/ports/workflow.ts.
 *
 * Ordering / delivery guarantees:
 * - Synchronous, in-process delivery.
 * - Handlers are invoked in registration order.
 */
export interface IGitEventBus {
  /** Synchronously deliver event to all registered handlers. */
  emit(event: GitEvent): void;

  /** Register a handler to receive all future events. */
  on(handler: (event: GitEvent) => void): void;

  /** Unregister a previously registered handler. */
  off(handler: (event: GitEvent) => void): void;
}
