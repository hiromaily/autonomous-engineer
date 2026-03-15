# Implementation Plan

<!-- cspell:ignore openspec speckit citty -->

- [x] 1. Add application port interfaces for the configure feature
  - Add `WritableConfig` interface covering `llm.provider`, `llm.modelName`, `specDir`, and `sddFramework` — API key field intentionally excluded
  - Add `FrameworkCheckResult` discriminated union: `{ installed: true }` or `{ installed: false; hint: string }`
  - Add `IConfigWriter` interface with a `write(config, cwd?)` method
  - Add `IFrameworkChecker` interface with a `check(framework, cwd?)` method
  - _Requirements: 4.1, 5.1, 5.4_

- [ ] 2. Implement infrastructure adapters
- [ ] 2.1 (P) Implement the config file writer adapter
  - Write `aes.config.json` in the target directory by serializing only the `WritableConfig` fields
  - Ensure `llm.apiKey` is structurally absent from the output (enforced by the type, not a runtime filter)
  - Propagate filesystem write errors to the caller without leaving a partial file on disk
  - Depends on Task 1 for port type definitions
  - _Requirements: 5.1, 5.3, 5.4_

- [ ] 2.2 (P) Implement the SDD framework installation checker adapter
  - Dispatch to a per-framework check strategy based on the selected framework name
  - For `cc-sdd`: check whether a `.kiro/` directory exists in the project root; return `installed: false` with an installation hint if absent
  - For `openspec` and `speckit`: return `installed: true` (checks undefined pending future specification)
  - Depends on Task 1 for port type definitions
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 3. Implement the interactive configuration wizard
- [ ] 3.1 (P) Add `@clack/prompts` dependency and implement the four-step prompt sequence
  - Add `@clack/prompts` as a production dependency in `orchestrator-ts/package.json`
  - Present prompts in order: LLM provider (select) → model name (text) → SDD framework (select) → spec directory (text)
  - Provide sensible defaults for each prompt (provider: `claude`, modelName: `claude-opus-4-6`, sddFramework: `cc-sdd`, specDir: `.kiro/specs`)
  - Re-prompt for any required text field left empty
  - _Requirements: 2.1, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 3.2 Pre-populate prompts from existing config and handle cancellation
  - Accept an optional `defaults` object to pre-fill each prompt with current values from an existing `aes.config.json`
  - Detect cancellation at every step (`isCancel` check) and return `"cancelled"` immediately without further prompts
  - Display a post-wizard message instructing the user to set `AES_LLM_API_KEY` as an environment variable (no API key prompt in the wizard itself)
  - _Requirements: 2.2, 2.4, 3.6_

- [ ] 4. Implement the `ConfigureCommand` orchestrator
- [ ] 4.1 Implement non-TTY guard and wizard launch
  - Check `process.stdin.isTTY` before starting the wizard; exit with a clear error if not running in a terminal
  - Attempt to load `aes.config.json` partially (raw JSON parse, ignoring validation errors) to supply defaults to the wizard; treat a missing or malformed file as "no defaults"
  - Pass loaded defaults to the wizard and await the result
  - _Requirements: 2.1, 2.2, 2.3, 2.5_

- [ ] 4.2 Integrate framework check and config write with correct flow control
  - If the wizard returns `"cancelled"`, exit cleanly without writing any file
  - After a successful wizard result, invoke the framework checker with the selected SDD framework
  - If the framework is not detected, display the checker's hint message and exit without writing the config file
  - If all checks pass, invoke the config writer and display a confirmation message with the written file path
  - Catch and display any write errors, then exit without leaving a partial file
  - _Requirements: 2.4, 4.1, 4.3, 4.4, 4.5, 5.2, 5.3, 5.4_

- [ ] 5. Wire the configure subcommand into the CLI entry point and improve the run error
- [ ] 5.1 Register the `configure` subcommand in the CLI entry point
  - Instantiate concrete infra implementations (`ConfigWriter`, `SddFrameworkChecker`) and inject them into `ConfigureCommand`
  - Register the command as `aes configure` using the existing CLI framework (`citty`)
  - _Requirements: 2.1_

- [ ] 5.2 Improve the `aes run` missing-configuration error message
  - In the `run` command's missing-config error branch, append an instruction to run `aes configure` to the error output
  - Display a warning identifying `AES_LLM_API_KEY` when that environment variable is absent
  - Ensure no interactive prompts are ever launched from within `aes run`
  - _Requirements: 1.1, 1.2, 1.3_

- [ ] 6. Unit tests
- [ ] 6.1 (P) Unit-test the config writer
  - Mock `node:fs/promises`; verify the written JSON matches the `WritableConfig` shape
  - Verify `apiKey` is absent from the output regardless of input
  - Verify write errors are propagated to the caller
  - _Requirements: 5.1, 5.3, 5.4_

- [ ] 6.2 (P) Unit-test the SDD framework checker
  - Mock `fs.access`; verify `cc-sdd` returns `installed: true` when `.kiro/` exists and `installed: false` with a hint when it does not
  - Verify `openspec` and `speckit` always return `installed: true`
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ] 6.3 (P) Unit-test the configuration wizard
  - Mock `@clack/prompts`; verify each prompt is displayed with the correct default value
  - Verify cancellation at any step returns `"cancelled"` without further interaction
  - Verify empty required text input triggers re-prompting
  - Verify the post-wizard API key guidance message is shown on completion
  - _Requirements: 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [ ] 6.4 (P) Unit-test the `ConfigureCommand` orchestrator
  - Mock all dependencies; verify the non-TTY guard exits before the wizard starts
  - Verify that a `"cancelled"` wizard result exits without calling the config writer
  - Verify that a failed framework check exits without calling the config writer
  - Verify the happy path calls the config writer and displays the confirmation and API key guidance
  - _Requirements: 2.1, 2.4, 2.5, 4.3, 4.4, 5.2, 5.3_

- [ ] 7. Integration tests
- [ ] 7.1 End-to-end `aes configure` with a real temp directory
  - Pipe wizard inputs via a stdin mock; verify `aes.config.json` is written with the correct schema
  - Verify `llm.apiKey` is not present in the written file
  - _Requirements: 2.1, 5.1, 5.4_

- [ ] 7.2 `aes run` missing-config error message validation
  - Invoke `aes run` without a config file; verify stderr contains an instruction to run `aes configure`
  - Invoke without `AES_LLM_API_KEY` set; verify the warning identifying the missing variable appears
  - _Requirements: 1.1, 1.2, 1.3_
