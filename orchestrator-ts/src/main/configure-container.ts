import type { IConfigWriter, IFrameworkChecker } from "@/application/ports/config";
import { ConfigWriter } from "@/infra/config/config-writer";
import { SddFrameworkChecker } from "@/infra/config/sdd-framework-checker";

export interface ConfigureDependencies {
  readonly configWriter: IConfigWriter;
  readonly frameworkChecker: IFrameworkChecker;
}

/**
 * DI container for the `configure` command.
 *
 * Constructor is pure — no-arg, nothing to store.
 * Dependencies are lazily instantiated and cached on first access.
 */
export class ConfigureContainer {
  private _configWriter?: IConfigWriter;
  private _frameworkChecker?: IFrameworkChecker;

  private get configWriter(): IConfigWriter {
    if (!this._configWriter) {
      this._configWriter = new ConfigWriter();
    }
    return this._configWriter;
  }

  private get frameworkChecker(): IFrameworkChecker {
    if (!this._frameworkChecker) {
      this._frameworkChecker = new SddFrameworkChecker();
    }
    return this._frameworkChecker;
  }

  build(): ConfigureDependencies {
    return {
      configWriter: this.configWriter,
      frameworkChecker: this.frameworkChecker,
    };
  }
}
