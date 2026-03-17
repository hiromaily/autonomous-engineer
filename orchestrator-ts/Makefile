
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

.PHONY: ts-lint-arch
ts-lint-arch:
	./scripts/lint-ts-architecture.sh

.PHONY: debug-aes-flow
debug-aes-flow:
	FORCE_COLOR=1 bun run aes run debug-aes-workflow --debug

.PHONY: rm-state
rm-state:
	rm -rf .aes/state/
