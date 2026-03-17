#!/usr/bin/env bash
set -euo pipefail

# Clean Architecture import checker
# - orchestrator-ts/src/README.md
# Enforces these boundaries:
# - domain is independent
# - application depends only on domain and application abstractions
# - adapters/cli calls use cases and stays thin
# - infra implements ports and owns technical details
# - main/di/ is the sub-system composition root; wires services+infra; only called from main/index
# - main/ is the top-level entry point and DI container; calls main/di/ only
#
# Usage:
#   bash scripts/check-architecture.sh
#
# Optional env:
#   ROOT_DIR=src
#   ALIAS_PREFIX=@/
#
# Exit codes:
#   0 = success
#   1 = violations found

ROOT_DIR="${ROOT_DIR:-src}"
ALIAS_PREFIX="${ALIAS_PREFIX:-@/}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required but not found." >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR" ]]; then
  echo "ERROR: ROOT_DIR '$ROOT_DIR' does not exist." >&2
  exit 1
fi

VIOLATIONS=0

RED=$'\033[31m'
YELLOW=$'\033[33m'
GREEN=$'\033[32m'
RESET=$'\033[0m'

RULES=(
  "src/domain/|src/domain/|src/application/ src/adapters/ src/infra/ src/main/di/|Domain must be fully independent"
  "src/application/usecases/|src/application/usecases/ src/application/services/ src/application/ports/ src/domain/|src/adapters/ src/infra/ src/main/di/|Use cases may depend only inward"
  "src/application/services/|src/application/services/ src/application/ports/ src/domain/|src/adapters/ src/infra/ src/main/di/|Application services are implementation-agnostic"
  "src/application/ports/|src/application/ports/ src/domain/|src/application/usecases/ src/application/services/ src/adapters/ src/infra/ src/main/di/|Ports define abstractions only"
  "src/adapters/cli/|src/adapters/cli/ src/application/ports/||CLI should stay thin"
  "src/infra/llm/|src/infra/llm/ src/application/ports/ src/domain/|src/application/usecases/ src/application/services/ src/adapters/ src/main/di/|Concrete port implementations only"
  "src/infra/git/|src/infra/git/ src/application/ports/ src/domain/|src/application/usecases/ src/application/services/ src/adapters/ src/main/di/|Concrete port implementations only"
  "src/infra/safety/|src/infra/safety/ src/application/ports/ src/domain/|src/application/usecases/ src/application/services/ src/adapters/ src/main/di/|Concrete runtime safety integrations only"
  "src/infra/sdd/|src/infra/sdd/ src/application/ports/ src/domain/|src/application/usecases/ src/application/services/ src/adapters/ src/main/di/|Concrete port implementations only"
  "src/infra/tools/|src/infra/tools/ src/application/ports/ src/domain/|src/application/usecases/ src/application/services/ src/adapters/ src/main/di/|Tool execution implementation only"
  "src/infra/memory/|src/infra/memory/ src/application/ports/ src/domain/|src/application/usecases/ src/application/services/ src/adapters/ src/main/di/|Persistence implementation only"
  "src/infra/planning/|src/infra/planning/ src/application/ports/ src/domain/|src/application/usecases/ src/application/services/ src/adapters/ src/main/di/|Planning persistence implementation only"
  "src/infra/events/|src/infra/events/ src/application/ports/ src/domain/|src/application/usecases/ src/application/services/ src/adapters/ src/main/di/|Event transport implementation only"
  "src/infra/state/|src/infra/state/ src/application/ports/ src/domain/|src/application/usecases/ src/application/services/ src/adapters/ src/main/di/|Workflow state persistence only"
  "src/infra/config/|src/infra/config/ src/application/ports/ src/domain/|src/application/usecases/ src/application/services/ src/adapters/ src/main/di/|Runtime config loading only"
  "src/infra/implementation-loop/|src/infra/implementation-loop/ src/application/ports/ src/domain/|src/application/usecases/ src/application/services/ src/adapters/ src/main/di/|Implementation loop persistence only"
  "src/infra/logger/|src/infra/logger/ src/application/ports/ src/domain/|src/application/usecases/ src/application/services/ src/adapters/ src/main/di/|Logger implementations only"
  "src/infra/utils/|src/infra/utils/ src/domain/|src/application/ src/adapters/ src/main/di/|Shared infra utilities only"
  "src/main/di/|src/main/di/ src/domain/ src/application/ src/adapters/ src/infra/||DI wires services and infra; never calls back into main"
  "src/main/|src/domain/ src/application/ src/adapters/ src/infra/ src/main/||Top-level entry point and DI container"
)

print_violation() {
  local file="$1"
  local line_no="$2"
  local line="$3"
  local reason="$4"
  local detail="$5"

  VIOLATIONS=$((VIOLATIONS + 1))
  echo "${RED}VIOLATION${RESET}: ${file}:${line_no}"
  echo "  Reason : ${reason}"
  echo "  Detail : ${detail}"
  echo "  Import : ${line}"
  echo
}

starts_with_any() {
  local value="$1"
  shift
  local prefix
  for prefix in "$@"; do
    [[ -z "$prefix" ]] && continue
    if [[ "$value" == "$prefix"* ]]; then
      return 0
    fi
  done
  return 1
}

trim_spaces() {
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

normalize_path() {
  local importer="$1"
  local raw="$2"

  # Ignore non-internal imports
  case "$raw" in
    ./*|../*|"$ALIAS_PREFIX"*)
      ;;
    *)
      return 1
      ;;
  esac

  local normalized=""

  if [[ "$raw" == "$ALIAS_PREFIX"* ]]; then
    normalized="${ROOT_DIR}/${raw#"$ALIAS_PREFIX"}"
  else
    local importer_dir
    importer_dir="$(dirname "$importer")"

    # Resolve relative path lexically
    normalized="$(python3 - <<'PY' "$importer_dir" "$raw"
import os, sys
base = sys.argv[1]
rel = sys.argv[2]
print(os.path.normpath(os.path.join(base, rel)).replace("\\", "/"))
PY
)"
  fi

  # Normalize common TS path shapes to a directory-ish prefix target
  normalized="${normalized%.ts}"
  normalized="${normalized%.tsx}"
  normalized="${normalized%.mts}"
  normalized="${normalized%.cts}"
  normalized="${normalized%/index}"

  printf '%s\n' "${normalized}/"
}

lookup_rule() {
  local file="$1"
  local rule
  for rule in "${RULES[@]}"; do
    IFS='|' read -r from allow deny notes <<< "$rule"
    if [[ "$file" == "$from"* ]]; then
      printf '%s\n' "$rule"
      return 0
    fi
  done
  return 1
}

extract_imports() {
  local file="$1"

  # Extract import/export specifiers and side-effect imports.
  # Output format: line_no<TAB>raw_line<TAB>module_specifier
  awk '
    {
      line=$0
      if (match(line, /^[[:space:]]*import[[:space:]].*from[[:space:]]*["'"'"'][^"'"'"']+["'"'"']/)) {
        s = substr(line, RSTART, RLENGTH)
        if (match(s, /["'"'"'][^"'"'"']+["'"'"']/)) {
          mod = substr(s, RSTART+1, RLENGTH-2)
          print NR "\t" line "\t" mod
        }
      } else if (match(line, /^[[:space:]]*export[[:space:]].*from[[:space:]]*["'"'"'][^"'"'"']+["'"'"']/)) {
        s = substr(line, RSTART, RLENGTH)
        if (match(s, /["'"'"'][^"'"'"']+["'"'"']/)) {
          mod = substr(s, RSTART+1, RLENGTH-2)
          print NR "\t" line "\t" mod
        }
      } else if (match(line, /^[[:space:]]*import[[:space:]]*["'"'"'][^"'"'"']+["'"'"']/)) {
        s = substr(line, RSTART, RLENGTH)
        if (match(s, /["'"'"'][^"'"'"']+["'"'"']/)) {
          mod = substr(s, RSTART+1, RLENGTH-2)
          print NR "\t" line "\t" mod
        }
      }
    }
  ' "$file"
}

check_layer_rules() {
  local file="$1"

  local rule
  if ! rule="$(lookup_rule "$file")"; then
    return 0
  fi

  local from allow deny notes
  IFS='|' read -r from allow deny notes <<< "$rule"

  local -a allow_prefixes deny_prefixes
  read -r -a allow_prefixes <<< "$allow"
  read -r -a deny_prefixes <<< "$deny"

  while IFS=$'\t' read -r line_no raw_line module_spec; do
    [[ -z "$module_spec" ]] && continue

    local normalized
    if ! normalized="$(normalize_path "$file" "$module_spec")"; then
      continue
    fi

    if starts_with_any "$normalized" "${deny_prefixes[@]}"; then
      print_violation \
        "$file" "$line_no" "$raw_line" \
        "Forbidden dependency by layer rule" \
        "'$normalized' matches denied prefixes for files under '$from' (${notes})"
      continue
    fi

    if ! starts_with_any "$normalized" "${allow_prefixes[@]}"; then
      print_violation \
        "$file" "$line_no" "$raw_line" \
        "Import outside allowed dependency set" \
        "'$normalized' does not match any allowed prefix for files under '$from' (${notes})"
      continue
    fi
  done < <(extract_imports "$file")
}

check_no_process_env_outside_config_di() {
  local file="$1"

  case "$file" in
    src/infra/config/*|src/main/*|src/adapters/cli/*)
      return 0
      ;;
  esac

  if grep -nH -E '\bprocess\.env\b' "$file" >/dev/null 2>&1; then
    while IFS=: read -r f line_no line; do
      print_violation \
        "$f" "$line_no" "$line" \
        "Direct environment access is restricted" \
        "Use infra/config or pass config via DI instead of reading process.env here"
    done < <(grep -nH -E '\bprocess\.env\b' "$file")
  fi
}

check_no_fs_child_process_outside_infra() {
  local file="$1"

  case "$file" in
    src/infra/*)
      return 0
      ;;
  esac

  if grep -nH -E '^[[:space:]]*import[[:space:]].*from[[:space:]]*["'"'"'](node:fs|fs|node:child_process|child_process)["'"'"']|^[[:space:]]*import[[:space:]]*["'"'"'](node:fs|fs|node:child_process|child_process)["'"'"']' "$file" >/dev/null 2>&1; then
    while IFS=: read -r f line_no line; do
      print_violation \
        "$f" "$line_no" "$line" \
        "Direct fs/child_process usage is restricted" \
        "Filesystem and process execution should live under infra"
    done < <(grep -nH -E '^[[:space:]]*import[[:space:]].*from[[:space:]]*["'"'"'](node:fs|fs|node:child_process|child_process)["'"'"']|^[[:space:]]*import[[:space:]]*["'"'"'](node:fs|fs|node:child_process|child_process)["'"'"']' "$file")
  fi
}


check_no_usecase_or_service_imports_in_infra_non_di() {
  local file="$1"

  case "$file" in
    src/main/*)
      return 0
      ;;
    src/infra/*)
      ;;
    *)
      return 0
      ;;
  esac

  while IFS=$'\t' read -r line_no raw_line module_spec; do
    [[ -z "$module_spec" ]] && continue
    local normalized
    if ! normalized="$(normalize_path "$file" "$module_spec")"; then
      continue
    fi

    case "$normalized" in
      src/application/usecases/*|src/application/services/*)
        print_violation \
          "$file" "$line_no" "$raw_line" \
          "Infra implementation depends on application orchestration" \
          "Only src/main/di may wire usecases/services; infra implementations should depend on ports instead"
        ;;
    esac
  done < <(extract_imports "$file")
}

check_no_di_imports_outside_main() {
  local file="$1"

  case "$file" in
    src/main/*)
      return 0
      ;;
    *)
      ;;
  esac

  while IFS=$'\t' read -r line_no raw_line module_spec; do
    [[ -z "$module_spec" ]] && continue
    local normalized
    if ! normalized="$(normalize_path "$file" "$module_spec")"; then
      continue
    fi

    case "$normalized" in
      src/main/di/*)
        print_violation \
          "$file" "$line_no" "$raw_line" \
          "Only src/main may import from src/main/di" \
          "src/main/di is the DI wiring layer; it must only be called from the composition root in src/main"
        ;;
    esac
  done < <(extract_imports "$file")
}

check_file() {
  local file="$1"
  check_layer_rules "$file"
  check_no_process_env_outside_config_di "$file"
  check_no_fs_child_process_outside_infra "$file"
  check_no_usecase_or_service_imports_in_infra_non_di "$file"
  check_no_di_imports_outside_main "$file"
}

echo "Checking architecture boundaries under ${ROOT_DIR} ..."

while IFS= read -r file; do
  check_file "$file"
done < <(find "$ROOT_DIR" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' \) | sort)

if [[ "$VIOLATIONS" -gt 0 ]]; then
  echo "${RED}Found ${VIOLATIONS} architecture violation(s).${RESET}"
  exit 1
fi

echo "${GREEN}Architecture check passed.${RESET}"
exit 0
