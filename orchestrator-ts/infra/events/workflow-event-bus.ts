import { EventEmitter } from 'node:events';
import type { IWorkflowEventBus, WorkflowEvent } from '../../application/ports/workflow';

const EVENT_NAME = 'workflow';

export class WorkflowEventBus implements IWorkflowEventBus {
  private readonly emitter = new EventEmitter();

  emit(event: WorkflowEvent): void {
    this.emitter.emit(EVENT_NAME, event);
  }

  on(handler: (event: WorkflowEvent) => void): void {
    this.emitter.on(EVENT_NAME, handler);
  }

  off(handler: (event: WorkflowEvent) => void): void {
    this.emitter.off(EVENT_NAME, handler);
  }
}
