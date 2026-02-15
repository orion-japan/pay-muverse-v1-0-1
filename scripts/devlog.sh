#!/usr/bin/env bash
set -euo pipefail

LOG="${LOG:-dev.live.log}"

# ここを統一の起点にする：毎回ログを作り直したいなら truncate
: > "$LOG"

echo "[devlog] writing to $LOG"
# stdbuf でバッファを殺して「ログが遅れて出る/出ない」を潰す
stdbuf -oL -eL npx next dev 2>&1 | stdbuf -oL -eL tee -a "$LOG"
