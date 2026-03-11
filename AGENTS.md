## Skills
### Available skills
- orchestrate-github-pr-review: End-to-end GitHub PR review pipeline that prepares a worktree, runs 5 category review skills in parallel, merges the JSON outputs, submits one PR review, and cleans up. (file: /mnt/data/joechenrh/raas/ai-engineer/skills/orchestrate-github-pr-review/SKILL.md)
- prepare-pr-diff-worktree: Create an isolated worktree for a PR, export the PR diff, and return `code_path`, `diff_filename`, and `work_tree`. (file: /mnt/data/joechenrh/raas/ai-engineer/skills/prepare-pr-diff-worktree/SKILL.md)
- review-clarity-naming-comment-intent: Review naming, clarity, and comment intent issues in behavior-changing PRs. (file: /mnt/data/joechenrh/raas/ai-engineer/skills/review-clarity-naming-comment-intent/SKILL.md)
- review-correctness: Review functional correctness, invariants, state integrity, concurrency safety, and regression risk. (file: /mnt/data/joechenrh/raas/ai-engineer/skills/review-correctness/SKILL.md)
- review-runtime-reliability-performance: Review runtime reliability, failure handling, concurrency, and performance risks. (file: /mnt/data/joechenrh/raas/ai-engineer/skills/review-runtime-reliability-performance/SKILL.md)
- review-scope-structure-abstraction: Review scope control, structure, encapsulation, abstraction quality, and duplication. (file: /mnt/data/joechenrh/raas/ai-engineer/skills/review-scope-structure-abstraction/SKILL.md)
- review-upgrade-compatibility-and-test-determinism: Review upgrade safety, compatibility, and test determinism risks. (file: /mnt/data/joechenrh/raas/ai-engineer/skills/review-upgrade-compatibility-and-test-determinism/SKILL.md)
- review-output-format: Render review findings into the required JSON payload format. (file: /mnt/data/joechenrh/raas/ai-engineer/skills/review-output-format/SKILL.md)
- merge-review-json-and-submit-pr-review: Merge category review JSON files and submit one GitHub PR review. (file: /mnt/data/joechenrh/raas/ai-engineer/skills/merge-review-json-and-submit-pr-review/SKILL.md)
- cleanup-pr-diff-worktree: Remove the temporary PR worktree after review. (file: /mnt/data/joechenrh/raas/ai-engineer/skills/cleanup-pr-diff-worktree/SKILL.md)

### How to use skills
- If a prompt names one of the skills above, invoke that skill directly instead of recreating its workflow manually.
- Prefer `orchestrate-github-pr-review` for initial PR review or recheck when given a GitHub PR link.
- Pass inputs using the exact parameter names defined in the target `SKILL.md`.
- Only use the smaller review-category skills directly when a prompt explicitly asks for a single review dimension.
