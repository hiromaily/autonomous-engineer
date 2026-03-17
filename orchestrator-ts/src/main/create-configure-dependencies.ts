import { ConfigureContainer } from "@/main/configure-container";
import type { ConfigureDependencies } from "@/main/configure-container";

export type { ConfigureDependencies };

export function createConfigureDependencies(): ConfigureDependencies {
  return new ConfigureContainer().build();
}
