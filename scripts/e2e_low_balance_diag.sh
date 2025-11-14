# file: scripts/e2e_low_balance_diag.sh
# 目的: 失敗点の自動特定
# - SA/APIキーの不一致（プロジェクトミスマッチ）
# - CustomToken→IDToken交換エラー（INVALID_CUSTOM_TOKEN / MISMATCH / API key誤り）
# - /api/debug/credits/set-balance の認可失敗
# - /api/agent/iros/reply の 401/402/500 と low_balance 警告有無
# 使い方:
#   chmod +x scripts/e2e_low_balance_diag.sh
#   ./scripts/e2e_low_balance_diag.sh /path/to/sa.json <FIREBASE_WEB_API_KEY> d20b5... 669933
set -euo pipefail

SA_PATH="${1:-}"; WEB_API_KEY="${2:-}"; CID="${3:-}"; USER_CODE="${4:-}"
API_ORIGIN="${API_ORIGIN:-http://localhost:3000}"
TOKEN_FILE="/tmp/_IDTOKEN"
TMP_JS="/tmp/_mint_diag.$$.$RANDOM.mjs"

# ---- 前提チェック ----
[ -n "$SA_PATH" ] || { echo "Usage: $0 /path/to/sa.json FIREBASE_WEB_API_KEY CID USER_CODE"; exit 1; }
[ -f "$SA_PATH" ] || { echo "ERR: SA JSON not found: $SA_PATH"; exit 2; }
[ -n "$WEB_API_KEY" ] || { echo "ERR: FIREBASE_WEB_API_KEY 未指定"; exit 3; }
[ -n "$CID" ] || { echo "ERR: CID 未指定"; exit 4; }
[ -n "$USER_CODE" ] || { echo "ERR: USER_CODE 未指定"; exit 5; }
command -v node >/dev/null || { echo "ERR: node が必要です"; exit 6; }
command -v jq   >/dev/null || { echo "ERR: jq が必要です"; exit 7; }
command -v curl >/dev/null || { echo "ERR: curl が必要です"; exit 8; }

# ---- SA 情報の抽出（プロジェクト一致性の事前診断）----
SA_PROJECT_ID="$(jq -r '.project_id // empty' "$SA_PATH")"
SA_CLIENT_EMAIL="$(jq -r '.client_email // empty' "$SA_PATH")"
[ -n "$SA_PROJECT_ID" ] || { echo "ERR: SA に project_id がありません"; exit 9; }
[ -n "$SA_CLIENT_EMAIL" ] || { echo "ERR: SA に client_email がありません"; exit 10; }

echo "== SA info =="
echo "  project_id   : $SA_PROJECT_ID"
echo "  client_email : $SA_CLIENT_EMAIL"
echo

# ---- その場ミント（詳細ログあり）----
cat > "$TMP_JS" <<'MJS'
import fs from 'fs'; import crypto from 'crypto';

function b64url(buf){return Buffer.from(buf).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}
function b64urlJSON(o){return b64url(JSON.stringify(o))}
const now=()=>Math.floor(Date.now()/1000);

async function main(){
  const [,, uid, saPath, webApiKey] = process.argv;
  if(!uid||!saPath||!webApiKey){ console.error('ARG_ERR'); process.exit(90); }
  const sa = JSON.parse(fs.readFileSync(saPath,'utf8'));
  let pk = sa.private_key?.replace(/\\n/g,'\n'); const email = sa.client_email;
  if(!pk||!email){ console.error('SA_MISSING_FIELDS'); process.exit(91); }

  // Custom Token 生成
  const header={alg:'RS256',typ:'JWT'};
  const payload={
    iss:email, sub:email,
    aud:'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat:now(), exp:now()+300,
    uid, claims:{ role:'admin', user_code:'669933' }
  };
  const toSign=`${b64urlJSON(header)}.${b64urlJSON(payload)}`;
  const signer=crypto.createSign('RSA-SHA256'); signer.update(toSign); signer.end();
  const sig=b64url(signer.sign(pk));
  const customToken=`${toSign}.${sig}`;

  // 交換
  const url=`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`;
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:customToken,returnSecureToken:true})});
  const text=await res.text();
  if(!res.ok){
    console.error('XCHG_HTTP', res.status);
    try{ console.error('XCHG_BODY', text); }catch{}
    process.exit(92);
  }
  const j=JSON.parse(text);
  if(!j.idToken){ console.error('NO_IDTOKEN', text); process.exit(93); }
  fs.writeFileSync('/tmp/_IDTOKEN', j.idToken, {mode:0o600});
  console.log('MINT_OK');
  // 解析用: aud/iss/sub
  const mid=j.idToken.split('.')[1]; const pad='='.repeat((4-(mid.length%4))%4);
  const payload=JSON.parse(Buffer.from(mid+pad,'base64').toString('utf8'));
  console.log('PAYLOAD', JSON.stringify({aud:payload.aud, iss:payload.iss, sub:payload.sub, iat:payload.iat, exp:payload.exp}));
}
main().catch(e=>{ console.error('MINT_ERR', e.message||e); process.exit(99); });
MJS

echo "== Mint ID token (diagnostic) =="
set +e
node "$TMP_JS" "dev-${USER_CODE}" "$SA_PATH" "$WEB_API_KEY" 2>"/tmp/_mint_err.txt" 1>"/tmp/_mint_out.txt"
RC=$?
set -e
if [ $RC -ne 0 ]; then
  echo "× Mint failed (RC=$RC)"
  echo "--- stderr ---"; cat /tmp/_mint_err.txt; echo
  echo "考えられる原因:"
  echo "  - APIキーのFirebaseプロジェクト ≠ SAのproject_id（MISMATCHエラーが多い）"
  echo "  - APIキーがWeb API Keyでない / 無効"
  echo "  - SAのprivate_keyに改行問題（\\n → 実改行 変換済みだがJSONが壊れている場合）"
  exit 20
fi
echo "✓ Mint OK"
cat /tmp/_mint_out.txt
echo

# ---- 認証プローブ ----
echo "== Probe /api/credits/balance (with ID token) =="
PROBE_HTTP=$(curl -sS "${API_ORIGIN}/api/credits/balance" \
  -H "Authorization: Bearer $(cat $TOKEN_FILE)" \
  -H "x-user-code: ${USER_CODE}" \
  -o /tmp/_probe_body.json -w "%{http_code}")
echo "HTTP: $PROBE_HTTP"; cat /tmp/_probe_body.json; echo
if [ "$PROBE_HTTP" != "200" ]; then
  echo "× Auth probe failed（verifyFirebaseAndAuthorizeでreject）"
  echo "  → SA/APIキーのプロジェクト不一致や emulator/環境差異の可能性"
  exit 30
fi

# ---- 残高 7pt セット ----
echo "== Set balance to 7pt =="
SET_HTTP=$(curl -sS -X POST "${API_ORIGIN}/api/debug/credits/set-balance" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $(cat $TOKEN_FILE)" \
  -d "{\"user_code\":\"${USER_CODE}\",\"value\":7}" \
  -o /tmp/_set_body.json -w "%{http_code}")
echo "HTTP: $SET_HTTP"; cat /tmp/_set_body.json; echo
if [ "$SET_HTTP" = "401" ] || [ "$SET_HTTP" = "403" ]; then
  echo "× set-balance 認可失敗"
  echo "  → route.ts の verifyFirebaseAndAuthorize が弾いています。"
  echo "  対策: 一時的に 'if(!auth?.ok){401}' のみで roleチェックを外すか、claims側の role:'admin' を尊重する実装か確認。"
  exit 40
fi
[ "$SET_HTTP" = "200" ] || { echo "× set-balance 失敗（HTTP $SET_HTTP）"; exit 41; }

# ---- /api/agent/iros/reply 呼び出し ----
echo "== Call /api/agent/iros/reply (expect 200 & low_balance warn) =="
REQ=$(jq -n --arg cid "$CID" '{conversationId:$cid, text:"要件をレポート形式でまとめてください"}')
REPLY_HTTP=$(curl -sS -D /tmp/_iros_hdr.txt -o /tmp/_iros_body.json \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $(cat $TOKEN_FILE)" \
  -X POST "${API_ORIGIN}/api/agent/iros/reply" \
  -d "$REQ" -w "%{http_code}")
echo "HTTP: $REPLY_HTTP"
echo "--- headers ---"; cat /tmp/_iros_hdr.txt
echo "--- body ---"; cat /tmp/_iros_body.json; echo

if [ "$REPLY_HTTP" = "401" ]; then
  echo "× reply: 401 unauthorized → verifyFirebaseAndAuthorize が弾いています。"
  echo "  - トークンの aud/iss が想定と一致しているか（上の PAYLOAD 参照）。"
  echo "  - authz 内でプロジェクト/tenant固定の検証になっていないか。"
  exit 50
fi
if [ "$REPLY_HTTP" = "500" ]; then
  echo "× reply: 500 internal_error → generate() か credits/auto 内で例外。ログを確認。"
  exit 51
fi

# ---- low_balance 検査 ----
HDR_WARN=$(grep -i '^x-warning: *low_balance' /tmp/_iros_hdr.txt || true)
BODY_WARN=$(jq -r '..|objects|select(has("warning"))|.warning.code? // empty' /tmp/_iros_body.json 2>/dev/null || true)
if [ -n "$HDR_WARN" ] || [ "$BODY_WARN" = "low_balance" ]; then
  echo "✓ low_balance 警告 OK"
else
  echo "▲ 警告なし：残高/閾値/実装差異を確認（balanceが7、IROS_LOW_BALANCE_THRESHOLD=10であるか）"
fi
