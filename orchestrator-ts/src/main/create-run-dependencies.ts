import type { AesConfig } from "@/application/ports/config";
import { RunContainer } from "@/main/run-container";
import type { RunDependencies, RunOptions } from "@/main/run-container";

export type { RunDependencies, RunOptions };

export function createRunDependencies(
  config: AesConfig,
  options: RunOptions,
): RunDependencies {
  return new RunContainer(config, options).build();
}
