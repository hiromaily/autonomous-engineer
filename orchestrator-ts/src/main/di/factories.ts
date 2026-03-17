import type { AesConfig } from "@/application/ports/config";
import { ConfigureContainer } from "@/main/di/configure-container";
import type { ConfigureDependencies } from "@/main/di/configure-container";
import { RunContainer } from "@/main/di/run-container";
import type { RunDependencies, RunOptions } from "@/main/di/run-container";

export type { ConfigureDependencies, RunDependencies, RunOptions };

export function createConfigureDependencies(): ConfigureDependencies {
  return new ConfigureContainer().build();
}

export function createRunDependencies(
  config: AesConfig,
  options: RunOptions,
): RunDependencies {
  return new RunContainer(config, options).build();
}
