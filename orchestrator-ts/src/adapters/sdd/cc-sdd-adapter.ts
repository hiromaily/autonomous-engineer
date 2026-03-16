import type { SddFrameworkPort, SddOperationResult, SpecContext } from "@/application/ports/sdd";
import { join } from "node:path";

export type SpawnFn = (argv: readonly string[]) => {
  readonly exited: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array> | null;
};

const defaultSpawn: SpawnFn = (argv) => Bun.spawn(argv as string[], { stderr: "pipe" });

export class CcSddAdapter implements SddFrameworkPort {
  constructor(private readonly spawnFn: SpawnFn = defaultSpawn) {}

  initSpec(ctx: SpecContext): Promise<SddOperationResult> {
    return this.run("spec-init", ctx, "spec.json");
  }

  validatePrerequisites(ctx: SpecContext): Promise<SddOperationResult> {
    return this.run("validate-prerequisites", ctx, "requirements.md");
  }

  generateRequirements(ctx: SpecContext): Promise<SddOperationResult> {
    return this.run("requirements", ctx, "requirements.md");
  }

  validateRequirements(ctx: SpecContext): Promise<SddOperationResult> {
    return this.run("validate-requirements", ctx, "requirements.md");
  }

  reflectBeforeDesign(ctx: SpecContext): Promise<SddOperationResult> {
    return this.run("reflect", ctx, "requirements.md");
  }

  validateGap(ctx: SpecContext): Promise<SddOperationResult> {
    return this.run("validate-gap", ctx, "requirements.md");
  }

  generateDesign(ctx: SpecContext): Promise<SddOperationResult> {
    return this.run("design", ctx, "design.md");
  }

  validateDesign(ctx: SpecContext): Promise<SddOperationResult> {
    return this.run("validate-design", ctx, "design.md");
  }

  reflectBeforeTasks(ctx: SpecContext): Promise<SddOperationResult> {
    return this.run("reflect", ctx, "design.md");
  }

  generateTasks(ctx: SpecContext): Promise<SddOperationResult> {
    return this.run("tasks", ctx, "tasks.md");
  }

  validateTasks(ctx: SpecContext): Promise<SddOperationResult> {
    return this.run("validate-task", ctx, "tasks.md");
  }

  private async run(
    subcommand: string,
    ctx: SpecContext,
    artifactFile: string,
  ): Promise<SddOperationResult> {
    const argv = [
      "cc-sdd",
      subcommand,
      ctx.specName,
      "--spec-dir",
      ctx.specDir,
      "--language",
      ctx.language,
    ];

    const proc = this.spawnFn(argv);
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
    ]);

    if (exitCode !== 0) {
      return { ok: false, error: { exitCode, stderr: stderrText } };
    }

    return { ok: true, artifactPath: join(ctx.specDir, ctx.specName, artifactFile) };
  }
}
