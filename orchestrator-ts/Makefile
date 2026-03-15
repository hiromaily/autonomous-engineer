
.PHONY: ts-install
ts-install:
	bun install
	bunx lefthook install

# Run after ts files changed
# run `bun install`, if command is not found
.PHONY: ts-lint
ts-lint:
	bun run typecheck
	bun run fmt
	bun run lint:fix

.PHONY: debug-aes-flow
debug-aes-flow:
	bun run aes run debug-aes-workflow --debug-flow
