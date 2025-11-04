#!/usr/bin/env bash
set -euo pipefail

# ==== helpers ====
is_flat_config() { [[ -f "eslint.config.js" || -f "eslint.config.mjs" || -f "eslint.config.cjs" ]]; }

# Git管理下のJS/TSだけを対象にする（.next, node_modules 等は自然に除外）
files_list() {
  # 追跡中の拡張子だけ拾う
  git ls-files \
    '*.ts' '*.tsx' '*.js' '*.jsx' 2>/dev/null || true
}

run_eslint_fix() {
  local TARGETS
  TARGETS="$(files_list)"
  [[ -z "$TARGETS" ]] && return 0
  echo "[eslint] npx eslint --fix (tracked files only)"
  npx -y eslint $TARGETS --fix || true
}

run_eslint_errors_only() {
  local TARGETS
  TARGETS="$(files_list)"
  [[ -z "$TARGETS" ]] && return 0
  echo "---- ESLint (errorsのみ) ----"
  npx -y eslint $TARGETS --quiet || true
}

run_prettier() {
  echo "[prettier] npx prettier -w (tracked files only)"
  local TARGETS
  TARGETS="$(files_list)"
  [[ -z "$TARGETS" ]] && return 0
  npx -y prettier -w $TARGETS || true
}

# ==== 1) fatal系のピンポイント修正 ====

# A) no-control-regex: \x00 を含む行の直前に無効化コメントを（重複防止込み）
if [[ -f src/lib/ocr/cleanOcrText.ts ]]; then
  if grep -q '\\x00' src/lib/ocr/cleanOcrText.ts 2>/dev/null || grep -q $'\x00' src/lib/ocr/cleanOcrText.ts 2>/dev/null; then
    perl -0777 -pe '
      s{
        (^([ \t]*)
        (?!\/\/\s*eslint-disable-next-line\s+no-control-regex)
        (?=.*\\x00.*$)
      )
    }{$1\/\/ eslint-disable-next-line no-control-regex\n}gmx
    ' -i src/lib/ocr/cleanOcrText.ts || true
  fi
fi

# B) prefer-const: QTimelineField.tsx の let l → const l
if [[ -f src/components/qcode/QTimelineField.tsx ]]; then
  perl -pe 's/\blet\s+(l)\b/const $1/g' -i src/components/qcode/QTimelineField.tsx || true
fi

# C) prefer-const: src/lib/qcode/self.ts の hint/conf
if [[ -f src/lib/qcode/self.ts ]]; then
  perl -pe 's/\blet\s+(hint|conf)\b/const $1/g' -i src/lib/qcode/self.ts || true
fi

# ==== 2) 自動整形 ====
run_eslint_fix
run_prettier

# ==== 3) 結果（errorsのみ）
echo ""
run_eslint_errors_only

echo ""
echo "✅ 完了：.next/node_modules を含まない lint に切り替え、fatal パッチも適用しました。"
echo "   まだ errors が残る場合は、そのログを貼ってください。次の手当てを出します。"
