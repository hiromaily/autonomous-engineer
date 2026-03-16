<!-- SSOT: high-level SDD workflow summary (numbered list form).
     Included by: 
       docs/vision.md,
       docs/workflow/spec-driven-workflow.md
     Edit only this file when the summary workflow steps change. -->

1. spec-init *(llm slash command)*
2. human interaction *(user input)*
3. validate prerequisites met *(llm prompt)*
4. requirements *(llm slash command)*
5. validate-requirements *(llm prompt)*
6. reflect on existing information *(llm prompt)*
7. validate-gap *(llm slash command: optional)*
8. **`/clear` slash command** — reset context before design
9. design *(llm slash command)*
10. validate-design *(llm slash command: optional)*
11. reflect on existing information *(llm prompt)*
12. **`/clear` slash command** — reset context before task generation
13. tasks *(llm slash command)*
14. validate-tasks *(llm prompt)*
15. **`/clear` slash command** — reset context before implementation
16. implementation loop *(repeat per task group)*:
    - spec-impl *(llm slash command)*
    - validate-impl *(llm prompt)*
    - commit changes *(git command)*
    - **`/clear` slash command** — reset context before next task group
17. create PR *(git command)*
