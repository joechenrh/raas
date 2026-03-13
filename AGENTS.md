## Skills
### Available skills
- pr-review: End-to-end GitHub PR review pipeline. Prepares a worktree, runs 5 category reviews in parallel, merges findings, and submits one PR review. (file: /mnt/data/joechenrh/raas/ai-engineer/SKILL.md)
- dont-retest: Triage TiDB PR CI failures — collect failing checks, classify root cause, post structured report as PR comment. Report-only, no automated actions. (file: /mnt/data/joechenrh/.codex/skills/dont-retest/SKILL.md)

### How to use skills
- If a prompt names one of the skills above, invoke that skill directly instead of recreating its workflow manually.
- Prefer `pr-review` for initial PR review or recheck when given a GitHub PR link.
- Pass inputs using the exact parameter names defined in the target `SKILL.md`.
