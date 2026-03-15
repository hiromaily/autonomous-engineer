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

.PHONY: ts-lint
ts-lint:
	make -C orchestrator-ts ts-lint