import type { WorkflowEvent } from "@/application/ports/workflow";

/**
 * Renders workflow events as human-readable terminal output.
 * Accepts a write function to allow testing without real stdout.
 */
export class CliRenderer {
  constructor(private readonly write: (text: string) => void) {}

  handle(event: WorkflowEvent): void {
    switch (event.type) {
      case "phase:start":
        this.write(`\n=== ${event.phase} ===\n`);
        this.write(`  Started at: ${event.timestamp}\n`);
        break;

      case "phase:complete": {
        const seconds = (event.durationMs / 1000).toFixed(2);
        this.write(`  ✓ ${event.phase} completed in ${seconds}s\n`);
        if (event.artifacts.length > 0) {
          this.write(`  Artifacts:\n`);
          for (const artifact of event.artifacts) {
            this.write(`    - ${artifact}\n`);
          }
        }
        break;
      }

      case "phase:error":
        this.write(`  ✗ Error in ${event.phase} (${event.operation}): ${event.error}\n`);
        break;

      case "approval:required":
        this.write(`\n⏸  Approval required for ${event.phase}\n`);
        this.write(`  File: ${event.artifactPath}\n`);
        this.write(`  Action: ${event.instruction}\n`);
        break;

      case "workflow:complete":
        this.write(`\n✓ Workflow completed successfully!\n`);
        this.write(`  Phases completed: ${event.completedPhases.join(", ")}\n`);
        break;

      case "workflow:failed":
        this.write(`\n✗ Workflow failed at ${event.phase}: ${event.error}\n`);
        break;
    }
  }
}
