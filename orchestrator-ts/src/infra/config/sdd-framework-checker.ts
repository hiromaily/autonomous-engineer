import type { FrameworkCheckResult, IFrameworkChecker } from "@/application/ports/config";
import { access } from "node:fs/promises";
import { join } from "node:path";

export class SddFrameworkChecker implements IFrameworkChecker {
  async check(
    framework: "cc-sdd" | "openspec" | "speckit",
    cwd: string = process.cwd(),
  ): Promise<FrameworkCheckResult> {
    switch (framework) {
      case "cc-sdd":
        return this.checkCcSdd(cwd);
      case "openspec":
      case "speckit":
        return { installed: true };
    }
  }

  private async checkCcSdd(cwd: string): Promise<FrameworkCheckResult> {
    try {
      await access(join(cwd, ".kiro"));
      return { installed: true };
    } catch {
      return {
        installed: false,
        hint: "cc-sdd is not initialized in this directory. Run 'cc-sdd init' to set it up.",
      };
    }
  }
}
