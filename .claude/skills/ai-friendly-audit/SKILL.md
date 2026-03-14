---
name: ai-friendly-audit
description: Lightweight AI Friendliness check for a repository (no subagents, within 5 minutes). Quickly prioritizes basic improvements.
---

# AI-Friendly Repository Audit — Lite

Quickly check a repository's **AI agent readiness in a single pass without subagents**, and identify the most important basics to address first.

## Purpose

The full version (`ai-friendly-audit-full`) is precise with 21 Probes × 5 Workers but has high token cost. The Lite version uses **7 checks** to identify "what to do first", establishing a workflow where basics are addressed before deep-diving with the full version.

```
Lite basic check → Fix basics → Full precise evaluation → Continuous improvement
```

## When to Use

- When you want a quick overview of AI readiness for an unfamiliar repository
- As triage before running the full version
- Regular check to verify basic AI Agent configuration files are in place

## Arguments

- None (targets the entire repository)

## Execution Time

- **Target**: 2–5 minutes (no subagents, single pass)

---

## Checks

### Execution Steps

Run the following **7 checks in order**. Each check completes within a few tool calls.

---

### Check 1: Repository Profile (30 seconds)

**Purpose**: Understand scale and tech stack. Establishes context for subsequent checks.

**Steps**:

```bash
# File count by language
find . -type f \( -name "*.go" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.rb" -o -name "*.rs" -o -name "*.java" -o -name "*.kt" -o -name "*.cs" -o -name "*.swift" -o -name "*.php" \) \
  | grep -v node_modules | grep -v vendor | grep -v '.git/' | grep -v '/gen/' | grep -v '/generated/' \
  | sed 's/.*\.//' | sort | uniq -c | sort -rn

# Build system
ls -1 go.mod package.json pnpm-lock.yaml yarn.lock Cargo.toml pyproject.toml Gemfile build.gradle pom.xml Makefile 2>/dev/null

# Monorepo
ls -1 go.work pnpm-workspace.yaml lerna.json nx.json turbo.json 2>/dev/null
```

**Record**: Primary language, file count, scale (small/medium/large)

---

### Check 2: AI Agent Configuration Files (30 seconds)

**Purpose**: Verify existence of configuration files auto-loaded by each AI Agent. **The first step in AI readiness**.

**Steps**: Confirm existence of the following files at once:

```
Glob("AGENTS.md")
Glob("CLAUDE.md")
Glob(".claude/rules/*.md")
Glob(".claude/skills/*/SKILL.md")
Glob(".cursor/rules/*.md")
Glob(".cursor/skills/*/SKILL.md")
Glob(".github/copilot-instructions.md")
Glob(".windsurfrules")
```

**Scoring**:

| Score | Criteria |
|-------|----------|
| A | Rule files for 3+ Agents exist |
| B | Rule files for 1-2 Agents exist |
| C | No rule files |

**Record**: List of existing files and missing Agents

---

### Check 3: Entry Point Document Quality (1 minute)

**Purpose**: Verify that the document an AI should read first contains "usable" content.

**Steps**:

1. Read the first 50 lines of root README.md (or CLAUDE.md)
2. Check whether the following information is included:
   - [ ] Project overview (what the software does)
   - [ ] Directory structure description
   - [ ] Setup steps or list of development commands
   - [ ] Reference links to other documents
3. Freshness: Check last update with `git log -1 --format="%ai" -- README.md`

**Scoring**:

| Score | Criteria |
|-------|----------|
| A | 4/4 items present + updated within 6 months |
| B | 2-3/4 items present, or outdated (over 6 months) |
| C | 1/4 or fewer, or no README |

---

### Check 4: Directory Predictability (1 minute)

**Purpose**: Can code locations be inferred from feature names?

**Steps**:

1. Identify **2 key features** from README or top-level directory names
2. Run `Glob("**/{feature-name}*/**")` **once** for each feature name
3. Check whether the main directory for that code appears in results

**Scoring**:

| Score | Criteria |
|-------|----------|
| A | 2/2 found on first try |
| B | 1/2 successful |
| C | 0/2 successful |

---

### Check 5: Convention Documentation Level (1 minute)

**Purpose**: How well is implicit knowledge documented?

**Steps**: Check whether the following 3 categories are described in Agent auto-loaded documents (files found in Check 2):

1. **Build/Test commands**: Are development commands like `make verify`, `pnpm test` explicitly stated?
2. **Prohibitions**: Are there statements containing `DO NOT`, `NEVER`, `MUST NOT`, etc.?
3. **Code generation steps**: Are generated code existence and regeneration methods documented?

Search each category in Agent rule files + README/ARCHITECTURE.md:

```
Grep("(make |pnpm |npm |cargo |pytest|go test)", glob="{CLAUDE.md,AGENTS.md,README.md,.claude/rules/*.md,.cursor/rules/*.md}", output_mode="content", head_limit=10)
Grep("(DO NOT|NEVER|MUST NOT|IMPORTANT)", glob="{CLAUDE.md,AGENTS.md,README.md,.claude/rules/*.md,.cursor/rules/*.md}", output_mode="content", head_limit=10)
Grep("(generate|gen|codegen)", glob="{CLAUDE.md,AGENTS.md,README.md,.claude/rules/*.md,.cursor/rules/*.md,ARCHITECTURE.md}", output_mode="content", head_limit=10)
```

**Scoring**:

| Score | Criteria |
|-------|----------|
| A | 3/3 categories explicitly in Agent rule files |
| B | 1-2/3 documented, or in README but not Agent rules |
| C | Barely documented |

---

### Check 6: Pattern Consistency (Spot Check) (30 seconds)

**Purpose**: Verify code pattern uniformity at minimum cost.

**Steps**:

1. Select 2 subdirectories directly under the directory with the most source files
2. Compare subdirectory names of each directory (1 `ls` each)
3. Calculate percentage of matching directory names

**Scoring**:

| Score | Criteria |
|-------|----------|
| A | Match rate 75%+ |
| B | Match rate 50-74% |
| C | Match rate below 50% |

---

### Check 7: ARCHITECTURE.md / CODING_RULES.md Existence (30 seconds)

**Purpose**: Is architecture/coding convention documentation close to the code?

**Steps**:

```
Glob("**/ARCHITECTURE.md")
Glob("**/CODING_RULES.md")
Glob("**/CONTRIBUTING.md")
Glob("**/DEVELOPMENT.md")
Glob("**/STYLE_GUIDE.md")
```

Read the first 10 lines of found files and confirm they have substantive content (templates alone do not qualify).

**Scoring**:

| Score | Criteria |
|-------|----------|
| A | 2+ files with substantive content |
| B | 1 file only |
| C | None, or templates only |

---

## Score Calculation

### Overall Grade

A=3, B=2, C=1 per check, total (out of 21):

| Grade | Total | Meaning | Next Action |
|-------|-------|---------|-------------|
| **S** | 19-21 | Basics are sufficient | → Proceed to full version (`/ai-friendly-audit-full`) for precise evaluation |
| **A** | 15-18 | Generally good. Some reinforcement needed | → Improve C-rated items, then proceed to full version |
| **B** | 11-14 | Basics are lacking | → Implement improvement suggestions below |
| **C** | 7-10 | AI assistance is difficult | → Prioritize improvement suggestions below |

---

## Output Format

Output directly to terminal, then save the report to a file. Be concise.

### File Output

After displaying results in the terminal, save the same report to:

```
docs/ai-friendly-audit-report/{YYYY-MM-DD_HH-MM-SS}.md
```

- Obtain the timestamp by running `date +"%Y-%m-%d_%H-%M-%S"`.
- English only — `docs/ai-friendly-audit-report/` is excluded from the bilingual requirement (see `.claude/rules/docs.md`).
- The file content should match the terminal output format below, with a header including **Date** and **Tool** fields.

```markdown
## AI-Friendly Audit Lite

**Repository**: {name}
**Scale**: {small/medium/large} ({n} source files)
**Tech Stack**: {languages}

### Check Results

| # | Check Item | Score | Summary |
|---|-----------|-------|---------|
| 1 | Repository Profile | — | {scale and language summary} |
| 2 | AI Agent Config Files | {A/B/C} | {present/absent summary} |
| 3 | Entry Point Document | {A/B/C} | {quality summary} |
| 4 | Directory Predictability | {A/B/C} | {result summary} |
| 5 | Convention Documentation | {A/B/C} | {coverage summary} |
| 6 | Pattern Consistency | {A/B/C} | {match rate} |
| 7 | Architecture Documents | {A/B/C} | {detection summary} |

### Overall Grade: {S/A/B/C} ({n}/21)

### Improvement Actions (by priority)

For C-rated items, provide specific improvement actions in 1-3 lines.

1. **{Check name}**: {what to do}
2. ...

### Next Step

- Grade S → `Run the full audit to identify precise improvement areas`
- Grade A/B/C → `Implement the improvements above, then re-run Lite. Once you reach S, proceed to the full version`
```

---

## Design Principles

- **No subagents**: All checks run sequentially in the main process
- **Minimize tool calls**: Each check completes in 2-5 tool calls (20-30 total)
- **Don't over-read files**: First N lines only. Full reads are prohibited
- **Concrete improvement suggestions**: Not "create a CLAUDE.md" but "create CLAUDE.md with the following content"
- **Bridge to full version**: Lite is triage for the full version. Once Lite reaches S, the full version adds value
