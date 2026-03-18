# Request

## Description

The design of `orchestrator-ts/.aes/workflow/cc-sdd.yaml` is generally good, but the `implementation_loop` phase type should be configurable via the YAML file as well.

Currently, the `implementation_loop` type in the YAML workflow definition has an empty `content` field and no configurable parameters — the orchestrator hardcodes all implementation loop behavior. The goal is to allow users to customize the implementation loop by specifying configuration options directly in the YAML workflow definition.

## Context

- Current YAML workflow file: `orchestrator-ts/.aes/workflow/cc-sdd.yaml`
- The `implementation_loop` phase currently looks like:
  ```yaml
  - phase: IMPLEMENTATION
    type: implementation_loop
    content: ""
    required_artifacts:
      - tasks.md
  ```
- The orchestrator is implemented in TypeScript at `orchestrator-ts/src/`
- The project follows Clean Architecture with strict layer separation
- Git branch: `main`
- Language: English

## Goal

Allow the `implementation_loop` phase type in the YAML file to carry configuration that customizes how the implementation loop runs. Examples of potentially configurable aspects:
- Which slash command or prompt to use for each task implementation
- Whether to run tests after each task
- Custom review configuration
- Any other behavioral parameters currently hardcoded in the orchestrator

The YAML schema, domain model, loader/validator, and any relevant application/domain logic should all be updated to support this.
