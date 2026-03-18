export interface SpecContext {
  readonly specName: string;
  readonly specDir: string;
  readonly language: string;
}

export type SddOperationResult =
  | { readonly ok: true; readonly artifactPath: string }
  | { readonly ok: false; readonly error: { readonly exitCode: number; readonly stderr: string } };

export interface SddFrameworkPort {
  /** Execute a named SDD command (e.g. "kiro:spec-requirements") for the given spec context. */
  executeCommand(commandName: string, ctx: SpecContext): Promise<SddOperationResult>;
}
