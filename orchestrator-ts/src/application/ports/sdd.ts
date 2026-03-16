export interface SpecContext {
  readonly specName: string;
  readonly specDir: string;
  readonly language: string;
}

export type SddOperationResult =
  | { readonly ok: true; readonly artifactPath: string }
  | { readonly ok: false; readonly error: { readonly exitCode: number; readonly stderr: string } };

export interface SddFrameworkPort {
  /** Validate that all prerequisites (e.g. requirements.md seed) exist before running SPEC_REQUIREMENTS. */
  validatePrerequisites(ctx: SpecContext): Promise<SddOperationResult>;
  /** Generate requirements document for the spec.
   *  Side effects are limited to specDir; workflow state is never modified. */
  generateRequirements(ctx: SpecContext): Promise<SddOperationResult>;
  /** Validate the generated requirements document for the spec. */
  validateRequirements(ctx: SpecContext): Promise<SddOperationResult>;
  /** Reflect on existing information to synthesize insights before design. */
  reflectOnExistingInformation(ctx: SpecContext): Promise<SddOperationResult>;
  /** Analyze the gap between requirements and the existing codebase. */
  validateGap(ctx: SpecContext): Promise<SddOperationResult>;
  /** Generate design document for the spec. */
  generateDesign(ctx: SpecContext): Promise<SddOperationResult>;
  /** Validate the design document for the spec. */
  validateDesign(ctx: SpecContext): Promise<SddOperationResult>;
  /** Generate implementation task list for the spec. */
  generateTasks(ctx: SpecContext): Promise<SddOperationResult>;
  /** Validate the generated task list for the spec. */
  validateTask(ctx: SpecContext): Promise<SddOperationResult>;
}
