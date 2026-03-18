---
description: Fix GitHub PR review comments and reply inline to each one
allowed-tools: Bash, Glob, Grep, Read, Write, Edit, MultiEdit
argument-hint: <PR-URL>[#pullrequestreview-ID]
---

# PR Review Fixer

Fix all review comments at **$ARGUMENTS** and reply inline to each one.

## Steps

1. **Parse the input** to extract the PR URL and optional review ID from `$ARGUMENTS`.
   - Example input: `https://github.com/owner/repo/pull/52#pullrequestreview-3965796881`
   - PR URL: `https://github.com/owner/repo/pull/52`
   - Review ID (optional): `3965796881`

2. **Fetch review comments** using `gh`:
   - If a review ID was provided: `gh api repos/{owner}/{repo}/pulls/reviews/{review_id}/comments`
   - Otherwise fetch all unresolved comments: `gh pr view {number} --repo {owner}/{repo} --json reviews,reviewThreads`
   - Also run `gh pr diff {number} --repo {owner}/{repo}` to get the current diff for context.

3. **Understand each comment**:
   - Read the file(s) referenced by each comment.
   - Understand what change the reviewer is requesting.

4. **Apply the fixes**:
   - Make the code changes requested by each review comment.
   - Keep changes minimal and focused — fix exactly what was asked.

5. **Reply inline to each comment** using the GitHub API:

   ```sh
   gh api repos/{owner}/{repo}/pulls/{pr_number}/comments/{comment_id}/replies \
     -f body="Done. <one-sentence description of what was changed>"
   ```

6. **Verify** by running the project's typecheck and test suite if applicable:

   ```sh
   cd orchestrator-ts && bun run typecheck && bun test
   ```

7. **Report** a summary of all changes made and replies posted.

## Notes

- Reply to every comment, even if no code change was needed (explain why).
- Keep reply messages concise and factual.
- Do not push or create commits unless explicitly asked.
