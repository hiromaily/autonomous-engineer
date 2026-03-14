import type { TaskPlan } from "./types";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface PlanValidationError {
  readonly code: "duplicate-id" | "missing-dependency" | "circular-dependency";
  readonly message: string;
}

export interface PlanValidationResult {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<PlanValidationError>;
  /** Topologically sorted step IDs in valid execution order; empty when valid is false. */
  readonly executionOrder: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// PlanValidator — pure domain service, no I/O
// ---------------------------------------------------------------------------

export class PlanValidator {
  validate(plan: TaskPlan): PlanValidationResult {
    const errors: PlanValidationError[] = [];

    // Collect all task and step IDs across the plan
    const allStepIds = new Set<string>();
    const allTaskIds = new Set<string>();

    // Phase 1: collect IDs and detect duplicates
    for (const task of plan.tasks) {
      if (allTaskIds.has(task.id)) {
        errors.push({
          code: "duplicate-id",
          message: `Duplicate task ID: "${task.id}"`,
        });
      } else {
        allTaskIds.add(task.id);
      }

      for (const step of task.steps) {
        if (allStepIds.has(step.id)) {
          errors.push({
            code: "duplicate-id",
            message: `Duplicate step ID: "${step.id}"`,
          });
        } else {
          allStepIds.add(step.id);
        }
      }
    }

    // Phase 2: verify all dependency references point to existing steps
    for (const task of plan.tasks) {
      for (const step of task.steps) {
        for (const depId of step.dependsOn) {
          if (!allStepIds.has(depId)) {
            errors.push({
              code: "missing-dependency",
              message: `Step "${step.id}" depends on non-existent step "${depId}"`,
            });
          }
        }
      }
    }

    // If there were duplicate IDs or missing dependencies, skip cycle detection
    // and return immediately with empty execution order
    if (errors.length > 0) {
      return { valid: false, errors, executionOrder: [] };
    }

    // Phase 3: Kahn's topological sort to detect cycles and compute execution order
    const { executionOrder, hasCycle } = kahnTopologicalSort(plan, allStepIds);

    if (hasCycle) {
      errors.push({
        code: "circular-dependency",
        message: "Circular dependency detected among plan steps",
      });
      return { valid: false, errors, executionOrder: [] };
    }

    return { valid: true, errors: [], executionOrder };
  }
}

// ---------------------------------------------------------------------------
// Kahn's algorithm
// ---------------------------------------------------------------------------

function kahnTopologicalSort(
  plan: TaskPlan,
  allStepIds: Set<string>,
): { executionOrder: string[]; hasCycle: boolean } {
  // Build adjacency list and in-degree map
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // depId → steps that depend on dep

  for (const id of allStepIds) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }

  for (const task of plan.tasks) {
    for (const step of task.steps) {
      for (const depId of step.dependsOn) {
        // depId must exist (validated in phase 2) — but guard for safety
        if (!allStepIds.has(depId)) continue;
        inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
        dependents.get(depId)?.push(step.id);
      }
    }
  }

  // Start with all nodes that have no incoming edges
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const executionOrder: string[] = [];

  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    executionOrder.push(current);

    for (const dependent of dependents.get(current) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  const hasCycle = executionOrder.length !== allStepIds.size;
  return { executionOrder, hasCycle };
}
