


#!/usr/bin/env bash
# Iros 共鳴API スモークテスト（自動トークン発行・無プロンプト・貼り付け安全／SA ファイル対応）
# - exit / set -e 不使用（途中エラーでも継続）
# - SA は 1) FIREBASE_SERVICE_ACCOUNT_FILE（JSONパス）→ 2) FIREBASE_SERVICE_ACCOUNT_KEY（JSON文字列）
#        → 3) FIREBASE_ADMIN_KEY_BASE64（base64 JSON）の順で取得
# - Firebase CustomToken → IDToken を自動発行して Bearer で叩く

main() {
  BASE="${BASE:-http://localhost:3000}"
  CID="${CID:-d20b5966-2c12-4ddc-9f4b-f74468b2d54b}"
  FALLBACK_FB_UID="${FALLBACK_FB_UID:-1000}"
  FAILED=0

  has(){ command -v "$1" >/dev/null 2>&1; }

  for c in curl jq openssl base64; do
    if ! has "$c"; then echo "WARN: $c not found. 中断（シェル継続）"; return 1; fi
  done

  : "${NEXT_PUBLIC_FIREBASE_API_KEY:=AIzaSyBGay9Y-7Ozd6-uqFB2gF6gm7gX6-qI9bA}"
  : "${FIREBASE_WEB_API_KEY:=${NEXT_PUBLIC_FIREBASE_API_KEY}}"

  banner(){ printf "\n==============================\n%s\n==============================\n" "$*"; }
  pass(){ printf "OK  %s\n" "$*"; }
  fail(){ printf "NG  %s\n" "$*"; FAILED=1; }

  # === SA JSON 取得（ファイル優先）===
  SA_JSON=""
  if [[ -n "${FIREBASE_SERVICE_ACCOUNT_FILE:-}" && -f "${FIREBASE_SERVICE_ACCOUNT_FILE}" ]]; then
    SA_JSON="$(cat -- "${FIREBASE_SERVICE_ACCOUNT_FILE}")"
  elif [[ -n "${FIREBASE_SERVICE_ACCOUNT_KEY:-}" ]]; then
    SA_JSON="${FIREBASE_SERVICE_ACCOUNT_KEY}"
  elif [[ -n "${FIREBASE_ADMIN_KEY_BASE64:-}" ]]; then
    SA_JSON="$(printf '%s' "$FIREBASE_ADMIN_KEY_BASE64" | base64 -d 2>/dev/null)"
  fi

  CLIENT_EMAIL="$(printf '%s' "$SA_JSON" | jq -r 'try .client_email // empty' 2>/dev/null)"
  PRIVATE_KEY_ESCAPED="$(printf '%s' "$SA_JSON" | jq -r 'try .private_key // empty' 2>/dev/null)"
  if [[ -z "$CLIENT_EMAIL" || -z "$PRIVATE_KEY_ESCAPED" ]]; then
    echo "WARN: SA JSON 解析失敗（client_email / private_key）"; return 1
  fi
  PRIVATE_KEY="$(printf '%s' "$PRIVATE_KEY_ESCAPED" | sed 's/\\n/\n/g')"

  # === CustomToken（RS256 署名）→ IDToken ===
  now=$(date +%s)
  exp=$((now + 3600))
  aud="https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit"
  uid="${FALLBACK_FB_UID}"

  header='{"alg":"RS256","typ":"JWT"}'
  payload=$(jq -nc --arg iss "$CLIENT_EMAIL" --arg sub "$CLIENT_EMAIL" --arg aud "$aud" --arg uid "$uid" --argjson iat "$now" --argjson exp "$exp" \
    '{iss:$iss,sub:$sub,aud:$aud,iat:$iat,exp:$exp,uid:$uid}')

  b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

  header_b64="$(printf '%s' "$header"  | b64url)"
  payload_b64="$(printf '%s' "$payload" | b64url)"
  to_sign="${header_b64}.${payload_b64}"

  signature_b64="$(printf '%s' "$to_sign" \
    | openssl dgst -sha256 -sign <(printf '%s' "$PRIVATE_KEY") -binary \
    | b64url)"

  custom_token="${to_sign}.${signature_b64}"

  banner "ISSUE IDTOKEN (uid=${uid})"
  id_resp="$(curl -sS -X POST \
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}" \
    -H 'content-type: application/json' \
    -d "$(jq -nc --arg t "$custom_token" '{token:$t, returnSecureToken:true}')" )" || true
  id_token="$(printf '%s' "$id_resp" | jq -r 'try .idToken // empty')"
  if [[ -z "$id_token" ]]; then
    echo "$id_resp" | jq .
    fail "IDTOKEN 発行に失敗"; return 1
  else
    pass "IDTOKEN 発行成功"
  fi

  # === /api/me ===
  banner "1) GET /api/me (Bearer)"
  me_json="$(curl -sS -H 'content-type: application/json' -H "Authorization: Bearer ${id_token}" "${BASE}/api/me")"
  echo "$me_json" | jq .
  echo "$me_json" | jq -e '.ok == true' >/dev/null && pass "/api/me ok" || fail "/api/me unauthorized"

  # === structured ===
  banner "2) POST /api/agent/iros/reply (structured)"
  req_structured=$(jq -n --arg cid "$CID" '{conversationId:$cid, text:"要件をレポート形式でまとめてください", hintText:"STRUCTUREDの口調で短く", extra:{traceId:"smoke-structured"}}')
  rs_structured="$(curl -sS -H 'content-type: application/json' -H "Authorization: Bearer ${id_token}" -X POST "${BASE}/api/agent/iros/reply" -d "$req_structured")"
  echo "$rs_structured" | jq .

  # === counsel ===
  banner "3) POST /api/agent/iros/reply (counsel)"
  req_counsel=$(jq -n --arg cid "$CID" '{conversationId:$cid, text:"相談があります"}')
  rs_counsel="$(curl -sS -H 'content-type: application/json' -H "Authorization: Bearer ${id_token}" -X POST "${BASE}/api/agent/iros/reply" -d "$req_counsel")"
  echo "$rs_counsel" | jq .

  # === diagnosis ===
  banner "4) POST /api/agent/iros/reply (diagnosis)"
  req_diag=$(jq -n --arg cid "$CID" '{conversationId:$cid, text:"ir診断で見てください", hintText:"IR診断 / diagnosis", extra:{traceId:"smoke-diagnosis"}}')
  rs_diag="$(curl -sS -H 'content-type: application/json' -H "Authorization: Bearer ${id_token}" -X POST "${BASE}/api/agent/iros/reply" -d "$req_diag")"
  echo "$rs_diag" | jq .

  # === BADTOKEN ===
  banner "5) BADTOKEN unauthorized"
  bad_json="$(curl -sS -H 'content-type: application/json' -H "Authorization: Bearer BADTOKEN" -X POST "${BASE}/api/agent/iros/reply" -d "$(jq -n --arg cid "$CID" '{conversationId:$cid, text:"ping"}')")"
  echo "$bad_json" | jq .

  echo; [[ $FAILED -eq 0 ]] && echo "🏁 All green（シェルは継続しています）" || echo "🏁 完了（失敗あり・シェルは継続）"
  return 0
}

main "$@" || true

