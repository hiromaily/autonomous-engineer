## Install Bun (if not installed) and install root package dependencies
.PHONY: setup
setup:
	@if ! command -v bun >/dev/null 2>&1; then \
		echo "Installing Bun..."; \
		curl -fsSL https://bun.sh/install | bash; \
	else \
		echo "Bun already installed: $$(bun --version)"; \
	fi
	bun install

## generate repository map as markdown
.PHONY: gen-repo-map
gen-repo-map:
	./scripts/generate-repo-map.sh

#------------------------------------------------------------------------------
# orchestrator-ts specific
#------------------------------------------------------------------------------

.PHONY: ts-lint
ts-lint:
	make -C orchestrator-ts ts-lint

.PHONY: ts-lint-arch
ts-lint-arch:
	make -C orchestrator-ts ts-lint-arch

.PHONY: debug-aes-flow
debug-aes-flow:
	$(MAKE) -C orchestrator-ts debug-aes-flow

.PHONY: restart-debug-aes-flow
restart-debug-aes-flow: rm-state debug-aes-flow

.PHONY: rm-state
rm-state:
	$(MAKE) -C orchestrator-ts rm-state

# bun run aes run debug-test --debug-flow
# bun run aes configure
# claude-opus-4-6 -> claude-sonnet-4-5, claude-haiku-4-5
