#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="/mnt/data/joechenrh/raas"
CODE_PATH="/mnt/data/joechenrh/raas/repos/pingcap/tidb/worktrees/pr-66917"
RUN_DIR="/mnt/data/joechenrh/raas/.pr-review-66917-1773320907"

skills=(
  "review-clarity-naming-comment-intent"
  "review-correctness"
  "review-runtime-reliability-performance"
  "review-scope-structure-abstraction"
  "review-upgrade-compatibility-and-test-determinism"
)

for skill in "${skills[@]}"; do
  prompt="$RUN_DIR/${skill}.prompt"
  output="$RUN_DIR/${skill}.json"
  lastmsg="$RUN_DIR/${skill}.last.txt"
  log="$RUN_DIR/${skill}.log"
  cat > "$prompt" <<PROMPT
Invoke skill \`${skill}\` directly.
Inputs: \`code_path=${CODE_PATH}\`, \`diff_filename=66917.diff\`, \`output_filename=${output}\`.
Write output JSON to exactly \`output_filename\`.
Run this child process with write-capable filesystem access matching the parent execution mode.
This codex exec child process is already the required reviewer subagent.
Do not run in parent; execute in this child process only.
Do not call spawn_agent, collab, Task, or delegate to any additional subagents.
Keep the child working directory at ${REPO_ROOT}; access the reviewed checkout via the provided additional writable scope.
PROMPT
  : > "$log"
  codex exec --dangerously-bypass-approvals-and-sandbox -C "$REPO_ROOT" --add-dir "$CODE_PATH" --ephemeral -o "$lastmsg" - < "$prompt" > "$log" 2>&1 &
  echo $! > "$RUN_DIR/${skill}.pid"
done

printf '{"run_dir":"%s","started":["%s","%s","%s","%s","%s"]}\n' \
  "$RUN_DIR" \
  "${skills[0]}" "${skills[1]}" "${skills[2]}" "${skills[3]}" "${skills[4]}"
