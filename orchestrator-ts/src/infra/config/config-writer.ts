import type { IConfigWriter, WritableConfig } from "@/application/ports/config";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export class ConfigWriter implements IConfigWriter {
  async write(config: WritableConfig, cwd: string = process.cwd()): Promise<void> {
    const configPath = join(cwd, "aes.config.json");
    const output: WritableConfig = {
      llm: {
        provider: config.llm.provider,
        modelName: config.llm.modelName,
      },
      specDir: config.specDir,
      sddFramework: config.sddFramework,
    };
    await writeFile(configPath, JSON.stringify(output, null, 2), "utf-8");
  }
}
