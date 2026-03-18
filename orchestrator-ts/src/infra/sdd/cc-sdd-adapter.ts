import type { SddFrameworkPort, SddOperationResult, SpecContext } from "@/application/ports/sdd";
import { join } from "node:path";

export type SpawnFn = (argv: readonly string[]) => {
  readonly exited: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array> | null;
};

const defaultSpawn: SpawnFn = (argv) => Bun.spawn(argv as string[], { stderr: "pipe" });

const COMMAND_MAP: ReadonlyMap<string, { readonly subcommand: string; readonly artifactFile: string }> = new Map([
  ["kiro:spec-init", { subcommand: "spec-init", artifactFile: "spec.json" }],
  ["kiro:spec-requirements", { subcommand: "requirements", artifactFile: "requirements.md" }],
  ["kiro:validate-gap", { subcommand: "validate-gap", artifactFile: "requirements.md" }],
  ["kiro:spec-design", { subcommand: "design", artifactFile: "design.md" }],
  ["kiro:validate-design", { subcommand: "validate-design", artifactFile: "design.md" }],
  ["kiro:spec-tasks", { subcommand: "tasks", artifactFile: "tasks.md" }],
]);

export class CcSddAdapter implements SddFrameworkPort {
  constructor(private readonly spawnFn: SpawnFn = defaultSpawn) {}

  executeCommand(commandName: string, ctx: SpecContext): Promise<SddOperationResult> {
    const entry = COMMAND_MAP.get(commandName);
    if (!entry) {
      return Promise.resolve({
        ok: false,
        error: { exitCode: 1, stderr: `Unknown command: ${commandName}` },
      });
    }
    return this.run(entry.subcommand, ctx, entry.artifactFile);
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
