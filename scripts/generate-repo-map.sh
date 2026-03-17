#!/usr/bin/env bash
set -euo pipefail

OUT=".claude/rules/repo-map.md"

IGNORE_TREE='node_modules|dist|build|coverage|.git|.next|vendor|tmp|.turbo|.cache|out'

# ------------------------------------------------------------------
# Inline description registry
# Format:
#   path<TAB>description
#
# Matching behavior:
# - exact match preferred
# - otherwise longest prefix match wins
# ------------------------------------------------------------------
read -r -d '' PATH_DESCRIPTIONS <<'EOF' || true
.claude	Claude Code configuration, rules, and helper assets
.claude/commands	Custom Claude Code command definitions
.claude/rules	Project rules, architecture notes, and coding guidance
.kiro	Spec-driven development (SDD) workspace: specs, steering, and settings used by the orchestrator (populated by the cc-sdd adapter); an essential runtime artifact directory for this system
.kiro/settings	Kiro settings, templates, and rule configuration
.kiro/specs	Feature specifications (requirements, design, tasks) — generated and consumed by the orchestrator's spec engine
.kiro/steering	Product, structure, and technical steering documents — loaded as persistent AI context
docs	Project documentation
docs/.vitepress	VitePress site configuration
docs/agent	Agent-related specifications and reference docs
docs/architecture	Architecture and design documentation
docs/development	Development workflow, policy, and environment docs
docs/frameworks	Framework-specific documentation
docs/ja	Japanese documentation
docs/memory	Memory system documentation
docs/workflow	Process and workflow documentation
orchestrator-ts	TypeScript implementation of the orchestrator (aes CLI)
orchestrator-ts/src	Production source code (Clean Architecture layers)
orchestrator-ts/src/main	Entry point + top-level DI container (outside Clean Architecture layers)
orchestrator-ts/src/main/di	Sub-system DI factories (only callable from main/)
orchestrator-ts/src/adapters	Inbound delivery adapters (CLI only)
orchestrator-ts/src/adapters/cli	Thin CLI handler: parse args, call use case, render output
orchestrator-ts/src/application	Application layer: use cases, services, port interfaces
orchestrator-ts/src/application/usecases	Top-level entrypoints for application actions (e.g. run-spec.ts)
orchestrator-ts/src/application/services	Reusable coordination logic (agent, context, git, safety, tools)
orchestrator-ts/src/application/ports	Abstract interface definitions (llm, memory, sdd, workflow)
orchestrator-ts/src/domain	Core domain models and business logic (no external dependencies)
orchestrator-ts/src/infra	Concrete port implementations and technical infrastructure
orchestrator-ts/tests	Test suites mirroring src/ structure (unit, integration, e2e)
orchestrator-ts/tests/adapters	Tests for adapters
orchestrator-ts/tests/application	Tests for application-layer behavior
orchestrator-ts/tests/domain	Tests for domain logic
orchestrator-ts/tests/e2e	End-to-end tests
orchestrator-ts/tests/infra	Tests for infrastructure components
orchestrator-ts/tests/integration	Integration tests across modules
scripts	Utility and maintenance scripts
README.md	Top-level project overview
CLAUDE.md	Project guidance for Claude Code
package.json	Node.js workspace and package configuration
LICENSE	Project license
EOF

lookup_description() {
  local target="$1"

  awk -F '\t' -v path="$target" '
    BEGIN {
      best_len = -1
      best_desc = ""
    }
    {
      key = $1
      desc = $2

      if (path == key) {
        print desc
        exit
      }

      if (index(path, key "/") == 1 || index(path, key) == 1) {
        if (length(key) > best_len) {
          best_len = length(key)
          best_desc = desc
        }
      }
    }
    END {
      if (best_desc != "") {
        print best_desc
      }
    }
  ' <<< "$PATH_DESCRIPTIONS"
}

print_item() {
  local path="$1"
  local indent="${2:-0}"
  local desc

  desc="$(lookup_description "$path" || true)"

  printf "%*s- \`%s\`" "$indent" "" "$path"
  if [ -n "${desc:-}" ]; then
    printf " - %s" "$desc"
  fi
  printf "\n"
}

list_subdirs() {
  local root="$1"

  find "$root" -mindepth 1 -maxdepth 2 -type d \
    ! -path '*/node_modules*' \
    ! -path '*/dist*' \
    ! -path '*/build*' \
    ! -path '*/coverage*' \
    ! -path '*/.git*' \
    ! -path '*/.next*' \
    ! -path '*/vendor*' \
    ! -path '*/tmp*' \
    ! -path '*/.turbo*' \
    ! -path '*/.cache*' \
    ! -path '*/out*' \
    | sed 's#^\./##' \
    | sort
}

list_top_level_dirs() {
  find . -mindepth 1 -maxdepth 1 -type d \
    ! -path './node_modules' \
    ! -path './dist' \
    ! -path './build' \
    ! -path './coverage' \
    ! -path './.git' \
    ! -path './.next' \
    ! -path './vendor' \
    ! -path './tmp' \
    ! -path './.turbo' \
    ! -path './.cache' \
    ! -path './out' \
    | sed 's#^\./##' \
    | sort
}

list_important_files() {
  local files=(
    "README.md"
    "CLAUDE.md"
    "package.json"
    "LICENSE"
    "tsconfig.json"
    "pnpm-workspace.yaml"
    "turbo.json"
    "biome.json"
  )

  for f in "${files[@]}"; do
    if [ -f "$f" ]; then
      echo "$f"
    fi
  done
}

{
  echo "# Repository Map"
  echo
  echo "Generated by scripts/generate-repo-map.sh: $(date '+%Y-%m-%d %H:%M:%S')"
  echo

  echo "## Overview"
  echo

  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    print_item "$dir"
  done < <(list_top_level_dirs)

  echo
  echo "## Important Files"
  echo

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    print_item "$file"
  done < <(list_important_files)

  echo
  echo "## Important Areas"
  echo

  while IFS= read -r root; do
    [ -n "$root" ] || continue

    echo
    echo "### \`$root/\`"
    echo

    root_desc="$(lookup_description "$root" || true)"
    if [ -n "${root_desc:-}" ]; then
      echo "$root_desc"
      echo
    fi

    has_children=0
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      print_item "$dir"
      has_children=1
    done < <(list_subdirs "$root")

    if [ "$has_children" -eq 0 ]; then
      echo "- No major subdirectories detected within depth 2"
    fi

    # Embed the canonical src/ directory structure from the SSOT partial
    if [ "$root" = "orchestrator-ts" ]; then
      PARTIAL="docs/_partials/src-directory-structure.md"
      if [ -f "$PARTIAL" ]; then
        echo
        echo "#### \`orchestrator-ts/src/\` Layout"
        echo
        # Strip the HTML comment block at the top of the partial, then include the rest
        sed '/^<!--/,/^.*-->$/d' "$PARTIAL"
      fi
    fi
  done < <(list_top_level_dirs)

  echo
  echo "## Compact Directory Tree"
  echo
  echo '```'
  tree -d -L 2 -I "$IGNORE_TREE" .
  echo '```'
} > "$OUT"

echo "Wrote $OUT"