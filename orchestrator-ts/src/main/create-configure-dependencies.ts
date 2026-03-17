import type { IConfigWriter, IFrameworkChecker } from "@/application/ports/config";
import { ConfigWriter } from "@/infra/config/config-writer";
import { SddFrameworkChecker } from "@/infra/config/sdd-framework-checker";

export interface ConfigureDependencies {
  readonly configWriter: IConfigWriter;
  readonly frameworkChecker: IFrameworkChecker;
}

export function createConfigureDependencies(): ConfigureDependencies {
  return {
    configWriter: new ConfigWriter(),
    frameworkChecker: new SddFrameworkChecker(),
  };
}
