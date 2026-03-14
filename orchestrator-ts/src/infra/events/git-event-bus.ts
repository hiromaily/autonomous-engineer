import type { IGitEventBus } from "@/application/ports/git-event-bus";
import type { GitEvent } from "@/domain/git/types";
import { EventEmitter } from "node:events";

const EVENT_NAME = "git";

export class GitEventBus implements IGitEventBus {
  private readonly emitter = new EventEmitter();

  emit(event: GitEvent): void {
    this.emitter.emit(EVENT_NAME, event);
  }

  on(handler: (event: GitEvent) => void): void {
    this.emitter.on(EVENT_NAME, handler);
  }

  off(handler: (event: GitEvent) => void): void {
    this.emitter.off(EVENT_NAME, handler);
  }
}
