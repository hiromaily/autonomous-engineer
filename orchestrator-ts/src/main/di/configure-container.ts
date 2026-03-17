import type { IConfigWriter, IFrameworkChecker } from "@/application/ports/config";
import type { ILogger } from "@/application/ports/logger";
import { ConfigWriter } from "@/infra/config/config-writer";
import { SddFrameworkChecker } from "@/infra/config/sdd-framework-checker";
import { ConsoleLogger } from "@/infra/logger/console-logger";

export interface ConfigureDependencies {
  readonly configWriter: IConfigWriter;
  readonly frameworkChecker: IFrameworkChecker;
  readonly logger: ILogger;
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
  private _logger?: ConsoleLogger;

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

  private get logger(): ConsoleLogger {
    if (!this._logger) {
      const isTTY = process.env.NO_COLOR !== undefined
        ? false
        : process.env.FORCE_COLOR !== undefined
        ? true
        : process.stderr.isTTY === true;
      this._logger = new ConsoleLogger("info", isTTY);
    }
    return this._logger;
  }

  build(): ConfigureDependencies {
    return {
      configWriter: this.configWriter,
      frameworkChecker: this.frameworkChecker,
      logger: this.logger,
    };
  }
}
