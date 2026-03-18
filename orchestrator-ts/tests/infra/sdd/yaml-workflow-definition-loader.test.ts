import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YamlWorkflowDefinitionLoader } from "@/infra/sdd/yaml-workflow-definition-loader";

// Path to the real workflow directory shipped with the project
const REAL_WORKFLOW_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".aes",
  "workflow",
);

// ─────────────────────────────────────────────────────────
// Integration tests — use the real cc-sdd.yaml
// ─────────────────────────────────────────────────────────
describe("YamlWorkflowDefinitionLoader — integration (real cc-sdd.yaml)", () => {
  const loader = new YamlWorkflowDefinitionLoader(REAL_WORKFLOW_DIR);

  it("happy path: returns definition with id === 'cc-sdd' and exactly 14 phases", async () => {
    const def = await loader.load("cc-sdd");

    expect(def.id).toBe("cc-sdd");
    expect(def.phases).toHaveLength(14);
  });

  it("type distribution: all llm_prompt phases have a non-undefined outputFile", async () => {
    const def = await loader.load("cc-sdd");
    const llmPromptPhases = def.phases.filter((p) => p.type === "llm_prompt");

    expect(llmPromptPhases.length).toBeGreaterThan(0);
    for (const phase of llmPromptPhases) {
      expect(phase.outputFile).toBeDefined();
    }
  });

  it("type distribution: all phases with approvalGate also have approvalArtifact", async () => {
    const def = await loader.load("cc-sdd");
    const gatedPhases = def.phases.filter((p) => p.approvalGate !== undefined);

    expect(gatedPhases.length).toBeGreaterThan(0);
    for (const phase of gatedPhases) {
      expect(phase.approvalArtifact).toBeDefined();
    }
  });

  it("unknown framework: rejects with message containing the file path and a creation hint", async () => {
    await expect(loader.load("unknown")).rejects.toThrow("unknown");
    await expect(loader.load("unknown")).rejects.toThrow(".aes/workflow/unknown.yaml");
  });

  it("IMPLEMENTATION phase has 4 loopPhases with correct phase names, types, and non-empty content for llm entries", async () => {
    const def = await loader.load("cc-sdd");
    const implPhase = def.phases.find((p) => p.type === "implementation_loop");

    expect(implPhase).toBeDefined();
    expect(implPhase?.loopPhases).toBeDefined();
    expect(implPhase?.loopPhases).toHaveLength(4);

    const loopPhases = implPhase!.loopPhases!;

    // Entry 0: SPEC_IMPL — llm_slash_command
    expect(loopPhases[0].phase).toBe("SPEC_IMPL");
    expect(loopPhases[0].type).toBe("llm_slash_command");
    expect(loopPhases[0].content.trim()).not.toBe("");

    // Entry 1: VALIDATE_IMPL — llm_prompt
    expect(loopPhases[1].phase).toBe("VALIDATE_IMPL");
    expect(loopPhases[1].type).toBe("llm_prompt");
    expect(loopPhases[1].content.trim()).not.toBe("");

    // Entry 2: COMMIT — git_command
    expect(loopPhases[2].phase).toBe("COMMIT");
    expect(loopPhases[2].type).toBe("git_command");

    // Entry 3: CLEAR_CONTEXT — llm_slash_command
    expect(loopPhases[3].phase).toBe("CLEAR_CONTEXT");
    expect(loopPhases[3].type).toBe("llm_slash_command");
    expect(loopPhases[3].content.trim()).not.toBe("");
  });
});

// ─────────────────────────────────────────────────────────
// Unit tests — fully isolated tmpdir
// ─────────────────────────────────────────────────────────
describe("YamlWorkflowDefinitionLoader — unit (tmpdir)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-loader-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("missing file: rejects with file-not-found error", async () => {
    const loader = new YamlWorkflowDefinitionLoader(tmpDir);
    await expect(loader.load("nonexistent")).rejects.toThrow("nonexistent");
  });

  it("malformed YAML: throws parse error referencing the file path", async () => {
    const filePath = path.join(tmpDir, "bad.yaml");
    fs.writeFileSync(filePath, "id: bad\nphases: [\n  - : {\n"); // invalid YAML
    const loader = new YamlWorkflowDefinitionLoader(tmpDir);
    await expect(loader.load("bad")).rejects.toThrow("bad.yaml");
  });

  it("duplicate phase: throws when two phases share the same name", async () => {
    const yaml = `
id: dup-test
phases:
  - phase: PHASE_A
    type: git_command
    content: ""
    required_artifacts: []
  - phase: PHASE_A
    type: git_command
    content: ""
    required_artifacts: []
`;
    const filePath = path.join(tmpDir, "dup-test.yaml");
    fs.writeFileSync(filePath, yaml);
    const loader = new YamlWorkflowDefinitionLoader(tmpDir);
    await expect(loader.load("dup-test")).rejects.toThrow("PHASE_A");
  });

  it("unknown execution type: throws listing valid types", async () => {
    const yaml = `
id: bad-type
phases:
  - phase: PHASE_X
    type: not_a_type
    content: ""
    required_artifacts: []
`;
    const filePath = path.join(tmpDir, "bad-type.yaml");
    fs.writeFileSync(filePath, yaml);
    const loader = new YamlWorkflowDefinitionLoader(tmpDir);
    await expect(loader.load("bad-type")).rejects.toThrow("not_a_type");
  });

  it("missing id: throws when YAML has no top-level id field", async () => {
    const yaml = `
phases:
  - phase: PHASE_A
    type: git_command
    content: ""
    required_artifacts: []
`;
    const filePath = path.join(tmpDir, "no-id.yaml");
    fs.writeFileSync(filePath, yaml);
    const loader = new YamlWorkflowDefinitionLoader(tmpDir);
    await expect(loader.load("no-id")).rejects.toThrow("id");
  });

  it("approvalArtifact override preserved: approval_artifact maps to approvalArtifact field", async () => {
    const yaml = `
id: override-test
phases:
  - phase: SPEC_REQUIREMENTS
    type: llm_slash_command
    content: "kiro:spec-requirements"
    required_artifacts:
      - requirements.md
    approval_gate: requirements
    approval_artifact: custom.md
`;
    const filePath = path.join(tmpDir, "override-test.yaml");
    fs.writeFileSync(filePath, yaml);
    const loader = new YamlWorkflowDefinitionLoader(tmpDir);
    const def = await loader.load("override-test");

    const phase = def.phases.find((p) => p.phase === "SPEC_REQUIREMENTS");
    expect(phase).toBeDefined();
    expect(phase?.approvalArtifact).toBe("custom.md");
  });

  // ── loop-phases unit tests ──────────────────────────────

  it("loop-phases: parses loop-phases array into loopPhases on the PhaseDefinition", async () => {
    const yaml = `
id: loop-test
phases:
  - phase: IMPLEMENTATION
    type: implementation_loop
    content: ""
    required_artifacts: []
    loop-phases:
      - phase: SPEC_IMPL
        type: llm_slash_command
        content: "kiro:spec-impl"
      - phase: COMMIT
        type: git_command
        content: ""
`;
    const filePath = path.join(tmpDir, "loop-test.yaml");
    fs.writeFileSync(filePath, yaml);
    const loader = new YamlWorkflowDefinitionLoader(tmpDir);
    const def = await loader.load("loop-test");

    const phase = def.phases.find((p) => p.phase === "IMPLEMENTATION");
    expect(phase).toBeDefined();
    expect(phase?.loopPhases).toBeDefined();
    expect(phase?.loopPhases).toHaveLength(2);
  });

  it("loop-phases: entries have correct phase, type, and content fields", async () => {
    const yaml = `
id: loop-fields-test
phases:
  - phase: IMPLEMENTATION
    type: implementation_loop
    content: ""
    required_artifacts: []
    loop-phases:
      - phase: SPEC_IMPL
        type: llm_slash_command
        content: "kiro:spec-impl"
      - phase: VALIDATE_IMPL
        type: llm_prompt
        content: "Review task {taskId}"
      - phase: COMMIT
        type: git_command
        content: ""
`;
    const filePath = path.join(tmpDir, "loop-fields-test.yaml");
    fs.writeFileSync(filePath, yaml);
    const loader = new YamlWorkflowDefinitionLoader(tmpDir);
    const def = await loader.load("loop-fields-test");

    const loopPhases = def.phases.find((p) => p.phase === "IMPLEMENTATION")?.loopPhases;
    expect(loopPhases).toBeDefined();
    expect(loopPhases![0].phase).toBe("SPEC_IMPL");
    expect(loopPhases![0].type).toBe("llm_slash_command");
    expect(loopPhases![0].content).toBe("kiro:spec-impl");
    expect(loopPhases![1].phase).toBe("VALIDATE_IMPL");
    expect(loopPhases![1].type).toBe("llm_prompt");
    expect(loopPhases![1].content).toBe("Review task {taskId}");
    expect(loopPhases![2].phase).toBe("COMMIT");
    expect(loopPhases![2].type).toBe("git_command");
    expect(loopPhases![2].content).toBe("");
  });

  it("loop-phases: throws when loop-phases is not an array", async () => {
    const yaml = `
id: loop-not-array
phases:
  - phase: IMPLEMENTATION
    type: implementation_loop
    content: ""
    required_artifacts: []
    loop-phases: "not-an-array"
`;
    const filePath = path.join(tmpDir, "loop-not-array.yaml");
    fs.writeFileSync(filePath, yaml);
    const loader = new YamlWorkflowDefinitionLoader(tmpDir);
    await expect(loader.load("loop-not-array")).rejects.toThrow("loop-phases");
    await expect(loader.load("loop-not-array")).rejects.toThrow("array");
  });

  it("loop-phases: throws on unknown type in an entry", async () => {
    const yaml = `
id: loop-bad-type
phases:
  - phase: IMPLEMENTATION
    type: implementation_loop
    content: ""
    required_artifacts: []
    loop-phases:
      - phase: SPEC_IMPL
        type: unknown_type
        content: "something"
`;
    const filePath = path.join(tmpDir, "loop-bad-type.yaml");
    fs.writeFileSync(filePath, yaml);
    const loader = new YamlWorkflowDefinitionLoader(tmpDir);
    await expect(loader.load("loop-bad-type")).rejects.toThrow("unknown_type");
  });

  it("loop-phases: throws on missing phase name in an entry", async () => {
    const yaml = `
id: loop-no-phase-name
phases:
  - phase: IMPLEMENTATION
    type: implementation_loop
    content: ""
    required_artifacts: []
    loop-phases:
      - type: git_command
        content: ""
`;
    const filePath = path.join(tmpDir, "loop-no-phase-name.yaml");
    fs.writeFileSync(filePath, yaml);
    const loader = new YamlWorkflowDefinitionLoader(tmpDir);
    await expect(loader.load("loop-no-phase-name")).rejects.toThrow("phase");
  });

  it("loop-phases: absence of loop-phases yields loopPhases === undefined", async () => {
    const yaml = `
id: loop-absent
phases:
  - phase: IMPLEMENTATION
    type: implementation_loop
    content: ""
    required_artifacts: []
`;
    const filePath = path.join(tmpDir, "loop-absent.yaml");
    fs.writeFileSync(filePath, yaml);
    const loader = new YamlWorkflowDefinitionLoader(tmpDir);
    const def = await loader.load("loop-absent");

    const phase = def.phases.find((p) => p.phase === "IMPLEMENTATION");
    expect(phase).toBeDefined();
    expect(phase?.loopPhases).toBeUndefined();
  });

  it("loop-phases: loop-phases on non-implementation_loop phase is silently ignored (loopPhases undefined)", async () => {
    const yaml = `
id: loop-ignored
phases:
  - phase: REQUIREMENTS
    type: llm_slash_command
    content: "kiro:spec-requirements"
    required_artifacts: []
    loop-phases:
      - phase: SPEC_IMPL
        type: llm_slash_command
        content: "kiro:spec-impl"
`;
    const filePath = path.join(tmpDir, "loop-ignored.yaml");
    fs.writeFileSync(filePath, yaml);
    const loader = new YamlWorkflowDefinitionLoader(tmpDir);
    const def = await loader.load("loop-ignored");

    const phase = def.phases.find((p) => p.phase === "REQUIREMENTS");
    expect(phase).toBeDefined();
    expect(phase?.loopPhases).toBeUndefined();
  });
});
