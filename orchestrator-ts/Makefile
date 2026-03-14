
# Run after ts files changed
# run `bun install`, if command is not found
.PHONY: ts-lint
ts-lint:
	bun run typecheck
	bun run fmt
	bun run lint:fix
