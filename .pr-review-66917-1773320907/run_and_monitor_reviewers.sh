#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="/mnt/data/joechenrh/raas"
CODE_PATH="/mnt/data/joechenrh/raas/repos/pingcap/tidb/worktrees/pr-66917"
RUN_DIR="/mnt/data/joechenrh/raas/.pr-review-66917-1773320907"
DIFF_FILENAME="66917.diff"

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
  rm -f "$output" "$lastmsg" "$log"
  cat > "$prompt" <<PROMPT
Invoke skill \`${skill}\` directly.
Inputs: \`code_path=${CODE_PATH}\`, \`diff_filename=${DIFF_FILENAME}\`, \`output_filename=${output}\`.
Write output JSON to exactly \`output_filename\`.
Run this child process with write-capable filesystem access matching the parent execution mode.
This codex exec child process is already the required reviewer subagent.
Do not run in parent; execute in this child process only.
Do not call spawn_agent, collab, Task, or delegate to any additional subagents.
Keep the child working directory at ${REPO_ROOT}; access the reviewed checkout via the provided additional writable scope.
PROMPT
  codex exec --dangerously-bypass-approvals-and-sandbox -C "$REPO_ROOT" --add-dir "$CODE_PATH" --ephemeral -o "$lastmsg" - < "$prompt" > "$log" 2>&1 &
  echo $! > "$RUN_DIR/${skill}.pid"
  printf 'started\t%s\tpid=%s\n' "$skill" "$!"
done

while true; do
  all_done=1
  printf 'status\t%s\n' "$(date -Iseconds)"
  for skill in "${skills[@]}"; do
    pid=$(cat "$RUN_DIR/${skill}.pid")
    if kill -0 "$pid" 2>/dev/null; then
      state=running
      all_done=0
    else
      state=exited
    fi
    out=no; [ -f "$RUN_DIR/${skill}.json" ] && out=yes
    last=no; [ -f "$RUN_DIR/${skill}.last.txt" ] && last=yes
    log_size=$(wc -c < "$RUN_DIR/${skill}.log" 2>/dev/null || echo 0)
    printf '%s\t%s\tjson=%s\tlast=%s\tlog_bytes=%s\n' "$skill" "$state" "$out" "$last" "$log_size"
  done
  if [ "$all_done" -eq 1 ]; then
    break
  fi
  sleep 30
done

for skill in "${skills[@]}"; do
  pid=$(cat "$RUN_DIR/${skill}.pid")
  if wait "$pid"; then
    rc=0
  else
    rc=$?
  fi
  printf 'exit\t%s\trc=%s\n' "$skill" "$rc"
done
