// ---------------------------------------------------------------------------
// Shared tool-name sets used by both the domain layer (RateLimitGuard) and
// the application layer (SafetyGuardedToolExecutor) for session accounting.
// Defined here to avoid duplication and keep definitions in sync.
// ---------------------------------------------------------------------------

/** Tool names that trigger the per-session repository write counter. */
export const REPO_WRITE_TOOLS = new Set(["git_commit", "git_branch_create", "git_push"]);

/** Tool names that trigger the per-minute external API request counter. */
export const API_REQUEST_TOOLS = new Set(["llm_chat", "llm_complete", "search_web", "fetch_url"]);
