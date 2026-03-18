import { load as yamlLoad } from "js-yaml";
import type { FrameworkDefinitionPort } from "@/application/ports/framework";
import {
  type FrameworkDefinition,
  type LoopPhaseDefinition,
  type LoopPhaseExecutionType,
  type PhaseDefinition,
  type PhaseExecutionType,
  VALID_LOOP_PHASE_EXECUTION_TYPES,
  validateFrameworkDefinition,
} from "@/domain/workflow/framework";
import type { ApprovalPhase } from "@/domain/workflow/approval-gate";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const VALID_EXECUTION_TYPES = new Set<string>([
  "llm_slash_command", "llm_prompt", "human_interaction",
  "suspension", "git_command", "implementation_loop",
]);

export class YamlWorkflowDefinitionLoader implements FrameworkDefinitionPort {
  constructor(
    private readonly workflowDir: string = join(process.cwd(), ".aes", "workflow"),
  ) {}

  async load(frameworkId: string): Promise<FrameworkDefinition> {
    const filePath = join(this.workflowDir, `${frameworkId}.yaml`);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      throw new Error(
        `Framework definition file not found: "${filePath}". ` +
        `Create ".aes/workflow/${frameworkId}.yaml" to register this framework.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = yamlLoad(raw);
    } catch (err) {
      throw new Error(`Failed to parse YAML at "${filePath}": ${String(err)}`);
    }
    const def = this.toFrameworkDefinition(parsed, filePath);
    validateFrameworkDefinition(def);
    return def;
  }

  private toFrameworkDefinition(raw: unknown, filePath: string): FrameworkDefinition {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`Invalid YAML structure in "${filePath}": expected an object at top level`);
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj["id"] !== "string" || obj["id"].trim() === "") {
      throw new Error(`YAML at "${filePath}" is missing a non-empty "id" field`);
    }
    if (!Array.isArray(obj["phases"])) {
      throw new Error(`YAML at "${filePath}" is missing a "phases" array`);
    }
    const phases = (obj["phases"] as unknown[]).map((p, i) => this.toPhaseDefinition(p, filePath, i));
    return { id: obj["id"] as string, phases };
  }

  private toLoopPhaseDefinition(
    raw: unknown,
    parentPhase: string,
    filePath: string,
    index: number,
  ): LoopPhaseDefinition {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(
        `loop-phases[${index}] in phase "${parentPhase}" of "${filePath}" is not an object`,
      );
    }
    const lp = raw as Record<string, unknown>;
    if (typeof lp["phase"] !== "string" || lp["phase"].trim() === "") {
      throw new Error(
        `loop-phases[${index}] in phase "${parentPhase}" of "${filePath}" is missing a "phase" name`,
      );
    }
    const type = lp["type"] as string;
    if (!VALID_LOOP_PHASE_EXECUTION_TYPES.has(type)) {
      throw new Error(
        `loop-phases[${index}] ("${lp["phase"]}") in phase "${parentPhase}" of "${filePath}" ` +
        `has unknown type "${type}". Valid types: ${[...VALID_LOOP_PHASE_EXECUTION_TYPES].join(", ")}`,
      );
    }
    return {
      phase: lp["phase"] as string,
      type: type as LoopPhaseExecutionType,
      content: typeof lp["content"] === "string" ? lp["content"] : "",
    };
  }

  private toPhaseDefinition(raw: unknown, filePath: string, index: number): PhaseDefinition {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`Phase at index ${index} in "${filePath}" is not an object`);
    }
    const p = raw as Record<string, unknown>;
    if (typeof p["phase"] !== "string" || p["phase"].trim() === "") {
      throw new Error(`Phase at index ${index} in "${filePath}" is missing a "phase" name`);
    }
    const type = p["type"] as string;
    if (!VALID_EXECUTION_TYPES.has(type)) {
      throw new Error(
        `Phase "${p["phase"]}" in "${filePath}" has unknown type "${type}". ` +
        `Valid types: ${[...VALID_EXECUTION_TYPES].join(", ")}`,
      );
    }
    const def: PhaseDefinition = {
      phase: p["phase"] as string,
      type: type as PhaseExecutionType,
      content: typeof p["content"] === "string" ? p["content"] : "",
      requiredArtifacts: ((): string[] => {
        const artifacts = p["required_artifacts"];
        if (artifacts === undefined) {
          return [];
        }
        if (!Array.isArray(artifacts) || !artifacts.every((item) => typeof item === "string")) {
          throw new Error(
            `Phase at index ${index} in "${filePath}" has invalid "required_artifacts": must be an array of strings.`,
          );
        }
        return artifacts;
      })(),
      ...(typeof p["approval_gate"] === "string" && { approvalGate: p["approval_gate"] as ApprovalPhase }),
      ...(typeof p["approval_artifact"] === "string" && { approvalArtifact: p["approval_artifact"] }),
      ...(typeof p["output_file"] === "string" && { outputFile: p["output_file"] }),
      ...((() => {
        if (type !== "implementation_loop") return {};
        const raw = p["loop-phases"];
        if (raw === undefined) return {};
        if (!Array.isArray(raw)) {
          throw new Error(
            `Phase "${p["phase"]}" in "${filePath}": "loop-phases" must be an array`,
          );
        }
        return {
          loopPhases: raw.map((lp, i) =>
            this.toLoopPhaseDefinition(lp, p["phase"] as string, filePath, i),
          ),
        };
      })()),
    };
    return def;
  }
}
