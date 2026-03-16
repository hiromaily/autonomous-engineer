<!-- SSOT: canonical workflow flow definition.
     Included by: docs/system-overview.md, docs/workflow/spec-driven-workflow.md,
                  docs/ja/system-overview.md, docs/ja/workflow/spec-driven-workflow.md
     Edit only this file when workflow steps change. -->

```
SPEC_INIT (llm slash command: `/kiro:spec-init <spec-name>`)
    ↓
HUMAN_INTERACTION (user input minimum requirements on `requirements.md` manually)
    ↓
VALIDATE_PREREQUISITES (llm prompt)
    ↓
SPEC_REQUIREMENTS (llm slash command: `/kiro:spec-requirements <spec-name>`)
    ↓
VALIDATE_REQUIREMENTS (llm prompt)
    ↓
REFLECT_ON_EXISTING_INFORMATION (llm prompt)
    ↓
VALIDATE_GAP (llm slash command: `/kiro:validate-gap <spec-name>` optional)
    ↓
CLEAR_CONTEXT (llm slash command: `/clear`)
    ↓
SPEC_DESIGN (llm slash command: `/kiro:spec-design -y <spec-name>`)
    ↓
VALIDATE_DESIGN (llm slash command: `/kiro:validate-design <spec-name>` optional)
    ↓
REFLECT_ON_EXISTING_INFORMATION (llm prompt)
    ↓
CLEAR_CONTEXT (llm slash command: `/clear`)
    ↓
SPEC_TASKS (TASK_GENERATION) (llm slash command: `/kiro:spec-tasks -y <spec-name>`)
    ↓
VALIDATE_TASK (llm prompt)
    ↓
CLEAR_CONTEXT (llm slash command: `/clear`)
    ↓
IMPLEMENTATION (llm slash command: `/kiro:spec-impl <spec-name> [task-ids]`)
    ↓
CLEAR_CONTEXT (llm slash command: `/clear`)
    ↓
PULL_REQUEST (git command)
```
