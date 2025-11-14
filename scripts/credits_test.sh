#!/usr/bin/env bash
# Muverse / Iros クレジット検証スクリプト
set -euo pipefail

API_ORIGIN="${API_ORIGIN:-http://localhost:3000}"
TOKEN_FILE="${TOKEN_FILE:-/tmp/_IDTOKEN}"
CID="${CID:-}"
AMOUNT="${AMOUNT:-5}"

if [ -z "${CID}" ]; then
  echo "ERR: CID が未設定です。例: CID=\"d20b5...\" $0 insufficient" >&2
  exit 1
fi
if [ ! -f "${TOKEN_FILE}" ]; then
  echo "ERR: トークンファイルが見つかりません: ${TOKEN_FILE}" >&2
  exit 1
fi

AUTH="Authorization: Bearer $(cat "${TOKEN_FILE}")"

call_reply() {
  local TXT="$1"
  curl -sS -X POST "${API_ORIGIN}/api/agent/iros/reply" \
    -H 'content-type: application/json' \
    -H "${AUTH}" \
    -d "{\"conversationId\":\"${CID}\",\"text\":\"${TXT}\"}" \
    -w '\nHTTP_STATUS:%{http_code}\n'
}

expect_case() {
  local MODE="$1"
  local TXT="$2"
  echo "[TEST] ${MODE} 実行中..."
  local RESP
  RESP=$(call_reply "${TXT}")
  echo "${RESP}" | tail -n 20
  local CODE
  CODE=$(echo "${RESP}" | grep 'HTTP_STATUS' | cut -d: -f2)

  if [ "${MODE}" = "insufficient" ] && [ "${CODE}" != "402" ]; then
    echo "✗ 不足テスト失敗 (期待 402, 実際 ${CODE})"
    exit 2
  elif [ "${MODE}" = "sufficient" ] && [ "${CODE}" != "200" ]; then
    echo "✗ 十分テスト失敗 (期待 200, 実際 ${CODE})"
    exit 3
  else
    echo "✓ ${MODE} OK"
  fi
}

case "${1:-}" in
  insufficient) expect_case insufficient "テスト（不足）" ;;
  sufficient)   expect_case sufficient "要件をレポート形式でまとめてください" ;;
  both)         expect_case insufficient "テスト（不足）"; sleep 1; expect_case sufficient "要件をレポート形式でまとめてください" ;;
  *) echo "Usage: CID=xxxx $0 {insufficient|sufficient|both}" ;;
esac

