# CLI Reference

## Overview

The `aes` CLI is the command-line interface for Autonomous Engineer.
It drives the full spec-driven workflow — from requirements through implementation — automatically from the terminal.

The CLI is implemented in TypeScript and runs on [Bun](https://bun.sh).

---

## Installation

From the `orchestrator-ts/` directory:

```sh
cd orchestrator-ts
bun install
```

To run the CLI during development:

```sh
bun run aes <command>
```

To install globally via Bun link:

```sh
cd orchestrator-ts
bun link
aes <command>
```

---

## Commands

### `aes run <spec-name>`

Run the full spec-driven workflow for the named spec.

```sh
aes run <spec-name> [options]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `spec-name` | Yes | Name of the spec to run (must match a directory under `specDir`) |

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `--provider <name>` | string | from config | Override the LLM provider for this run |
| `--dry-run` | boolean | `false` | Validate spec and config without executing the workflow |
| `--resume` | boolean | `false` | Resume from the last persisted workflow state |
| `--log-json <path>` | string | — | Write all workflow events as NDJSON to this file path |

**Examples:**

```sh
# Run the full workflow for spec "tool-system"
aes run tool-system

# Dry-run to validate config without executing
aes run tool-system --dry-run

# Resume a previously interrupted run
aes run tool-system --resume

# Override the provider and capture structured logs
aes run tool-system --provider claude --log-json ./logs/tool-system.ndjson
```

---

## Workflow Phases

When `aes run <spec>` is executed, the following phases run automatically in sequence:

```
SPEC_INIT
    ↓
REQUIREMENTS
    ↓
DESIGN
    ↓
VALIDATE_DESIGN
    ↓
TASK_GENERATION
    ↓
IMPLEMENTATION
    ↓
PULL_REQUEST
```

Each phase produces structured artifacts stored under `.kiro/specs/<spec-name>/`.

### Approval Gates

The workflow pauses for human review at three points:

| After phase | Artifact to review | Action |
|---|---|---|
| REQUIREMENTS | `requirements.md` | Confirm scope and requirements |
| DESIGN | `design.md` | Confirm architecture |
| TASK_GENERATION | `tasks.md` | Confirm implementation plan |

At each gate, the CLI displays the artifact path and waits for confirmation before proceeding.

To skip gates in trusted environments, configure `autoApprove: true` (not recommended for production use).

---

## Configuration

### Configuration File

Place `aes.config.json` at the project root (where you run `aes`):

```json
{
  "llm": {
    "provider": "claude",
    "modelName": "claude-opus-4-6",
    "apiKey": "sk-ant-..."
  },
  "specDir": ".kiro/specs",
  "sddFramework": "cc-sdd"
}
```

**Fields:**

| Field | Required | Default | Description |
|---|---|---|---|
| `llm.provider` | Yes | — | LLM provider (`claude` supported) |
| `llm.modelName` | Yes | — | Model identifier (e.g., `claude-opus-4-6`) |
| `llm.apiKey` | Yes | — | API key for the LLM provider |
| `specDir` | No | `.kiro/specs` | Directory containing spec subdirectories |
| `sddFramework` | No | `cc-sdd` | SDD framework adapter (`cc-sdd`, `openspec`, `speckit`) |

### Environment Variables

All configuration fields can be set via environment variables, which take priority over the config file:

| Variable | Description |
|---|---|
| `AES_LLM_PROVIDER` | LLM provider name |
| `AES_LLM_MODEL_NAME` | Model identifier |
| `AES_LLM_API_KEY` | API key |
| `AES_SPEC_DIR` | Spec directory path |
| `AES_SDD_FRAMEWORK` | SDD framework adapter |

**Git integration** (optional, all have defaults):

| Variable | Default | Description |
|---|---|---|
| `AES_GIT_BASE_BRANCH` | `main` | Base branch for feature branches |
| `AES_GIT_REMOTE` | `origin` | Git remote name |
| `AES_GIT_MAX_FILES_PER_COMMIT` | `50` | Safety limit on files per commit |
| `AES_GIT_PROTECTED_BRANCHES` | `main,master,production,release/*` | Comma-separated list of protected branches |
| `AES_GIT_IS_DRAFT` | `false` | Create PRs as drafts |
| `AES_GITHUB_TOKEN` | — | GitHub token for PR creation |

### Configuration Priority

Configuration is resolved in this order (highest priority first):

```
CLI flags  →  Environment variables  →  aes.config.json  →  Defaults
```

---

## State and Artifacts

| Path | Description |
|---|---|
| `.kiro/specs/<name>/` | Spec artifacts (requirements.md, design.md, tasks.md) |
| `.aes/state/<name>.json` | Persisted workflow state (enables `--resume`) |
| `.aes/logs/` | Implementation loop NDJSON logs |
| `.memory/` | Agent memory (rules, patterns, failure records) |

### Crash Recovery

If a run is interrupted (process killed, network failure, etc.), resume with:

```sh
aes run <spec-name> --resume
```

The workflow restarts from the last completed phase boundary.

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Workflow completed successfully |
| `1` | Workflow failed, configuration error, or spec not found |
