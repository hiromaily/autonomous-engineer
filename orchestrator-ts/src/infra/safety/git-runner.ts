import type { GitRunner } from "@/domain/safety/stateless-guards";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export const defaultGitRunner: GitRunner = async (args: string[], cwd: string): Promise<string> => {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout;
};
