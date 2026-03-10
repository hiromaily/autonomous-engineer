# SDD Frameworks

Autonomous Engineer integrates with external Spec-Driven Development (SDD) frameworks to manage the structured specification workflow.

Each framework defines its own phase structure, CLI commands, and artifact conventions. Before a new framework can be integrated, its workflow must be fully documented.

---

## Supported Frameworks

| Framework | Status | Documentation |
|---|---|---|
| [cc-sdd](https://github.com/gotalab/cc-sdd) | Active (initial) | [cc-sdd](./cc-sdd) |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | Documented | [OpenSpec](./openspec) |
| SpecKit | Planned | — |

---

## Integration Requirements

When adding a new SDD framework, the following must be documented before implementation begins:

- **Phase structure**: the ordered list of phases the framework defines
- **Commands**: CLI commands for each phase, including optional steps
- **Artifacts**: files produced at each phase and their expected format/location
- **Human review gates**: which phases require human approval before proceeding
- **Configuration**: how the framework is configured per project or per spec

This documentation lives in `docs/frameworks/<framework-name>.md` and must exist before the framework adapter is implemented.
