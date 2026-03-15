# Requirements Document

## Introduction

The `aes` CLI currently requires a pre-existing `aes.config.json` file or environment variables before it can run. New users have no guided way to create this configuration. This feature introduces an explicit `aes configure` subcommand that walks users through interactive setup and saves the result to `aes.config.json`. The `aes run` command is not changed — it continues to error if configuration is missing, directing the user to run `aes configure` first. The wizard also verifies that the selected SDD framework is installed in the project, providing a clear error message if it is not.

## Requirements

### Requirement 1: Missing Configuration Error on `aes run`

**Objective:** As a user, I want a clear and actionable error when I run `aes` without a valid configuration so that I know exactly what to do next.

#### Acceptance Criteria

1. When `aes run` is invoked and configuration is missing or incomplete, the CLI shall exit with a non-zero status code and display an error message that includes the missing fields and instructs the user to run `aes configure`.
2. When `aes run` is invoked and the LLM API key environment variable (`AES_LLM_API_KEY`) is not set, the CLI shall display a warning message identifying the missing environment variable before exiting.
3. The CLI shall not attempt to launch any interactive prompt from within `aes run`; all configuration must be performed via `aes configure`.

---

### Requirement 2: `aes configure` Subcommand

**Objective:** As a user, I want to run `aes configure` to set up or update my configuration interactively so that I can prepare `aes` for use without manually editing JSON files.

#### Acceptance Criteria

1. When the user runs `aes configure`, the CLI shall launch an interactive configuration wizard.
2. When `aes.config.json` already exists, the CLI shall pre-populate each prompt with the current values from the file so the user can accept them as defaults or change them.
3. When the user runs `aes configure` for the first time (no `aes.config.json`), all prompts shall start with empty or default values.
4. When the user cancels or exits the wizard early (e.g., via Ctrl+C), the CLI shall discard any partial changes and leave `aes.config.json` unchanged.
5. When running in a non-interactive environment (no TTY / stdin is not a terminal), the CLI shall exit with an error message indicating that interactive configuration is not supported in this context.

---

### Requirement 3: Interactive Configuration Prompts

**Objective:** As a user, I want to be prompted for each configuration value with clear options and defaults so that I can complete setup confidently.

#### Acceptance Criteria

1. When the configuration wizard runs, the CLI shall prompt the user to select an LLM provider from the list of supported providers (currently: `claude`).
2. When the user selects an LLM provider, the CLI shall prompt for the model name, displaying a suggested default value for that provider.
3. When prompting for the SDD framework, the CLI shall present the supported options (`cc-sdd`, `openspec`, `speckit`) as a selectable list and default to `cc-sdd`.
4. When prompting for the spec directory, the CLI shall present the default value (`.kiro/specs`) and allow the user to accept it or provide a custom path.
5. While the wizard is running, the CLI shall validate each response before advancing to the next prompt; if a required field is left empty, the CLI shall re-prompt the user.
6. The CLI shall not prompt for the LLM API key during the wizard; instead, it shall display a message at the end of the wizard instructing the user to set `AES_LLM_API_KEY` as an environment variable.

---

### Requirement 4: SDD Framework Installation Verification

**Objective:** As a user, I want to be informed if my chosen SDD framework is not installed in the current project so that I can take corrective action before proceeding.

#### Acceptance Criteria

1. When the user selects an SDD framework during configuration, the CLI shall check whether that framework is available in the current project.
2. Where the selected framework is `cc-sdd`, the CLI shall verify that a `.kiro/` directory exists in the project root as the indicator of installation. (Note: this condition is subject to change as other framework checks are defined.)
3. If the selected SDD framework is not detected, the CLI shall display an informative message identifying the missing framework and suggesting installation steps, then terminate gracefully without writing `aes.config.json`.
4. If the selected SDD framework is detected, the CLI shall continue to the next configuration step without interruption.
5. The CLI shall not attempt to automatically install the SDD framework; installation is left to the user.

---

### Requirement 5: Configuration File Generation

**Objective:** As a user, I want the wizard to save my configuration to `aes.config.json` so that future runs use my settings automatically without repeating setup.

#### Acceptance Criteria

1. When all required configuration values have been collected and validated, the CLI shall write them to `aes.config.json` in the current working directory using the expected JSON schema (`llm.provider`, `llm.modelName`, `specDir`, `sddFramework`).
2. When `aes.config.json` is written successfully, the CLI shall display a confirmation message showing the file path.
3. If writing `aes.config.json` fails (e.g., due to a permission error), the CLI shall display an error message with the reason and terminate without leaving a partial file.
4. The CLI shall never write the LLM API key to `aes.config.json`; the key is managed exclusively via the `AES_LLM_API_KEY` environment variable.
