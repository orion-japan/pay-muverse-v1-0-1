// file: scripts/mint_idtoken_from_sa.mjs
// 目的: Firebase カスタムトークン → IDトークン発行（/tmp/_IDTOKEN に保存）
// 使い方:
//   node scripts/mint_idtoken_from_sa.mjs dev-669933
//
// 必要ENV（いずれかの方法で提供）:
//   1) FIREBASE_SERVICE_ACCOUNT_FILE=/path/to/sa.json
//      -or- FIREBASE_ADMIN_KEY_BASE64=<base64-encoded sa.json>
//   2) NEXT_PUBLIC_FIREBASE_API_KEY（= Web API Key）
//      -or- FIREBASE_WEB_API_KEY
//
// 備考: プロジェクトにユーザーが未登録でも、Custom Token でサインイン時に自動作成されます。

import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

const UID = process.argv[2] || 'dev-669933';
const OUT = '/tmp/_IDTOKEN';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function b64urlJSON(obj) {
  return b64url(JSON.stringify(obj));
}
function loadSA() {
  const file = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
  const b64 = process.env.FIREBASE_ADMIN_KEY_BASE64;
  let jsonStr = null;
  if (file && fs.existsSync(file)) {
    jsonStr = fs.readFileSync(file, 'utf8');
  } else if (b64) {
    jsonStr = Buffer.from(b64, 'base64').toString('utf8');
  } else {
    throw new Error('Service Account が見つかりません。FIREBASE_SERVICE_ACCOUNT_FILE か FIREBASE_ADMIN_KEY_BASE64 を設定してください。');
  }
  return JSON.parse(jsonStr);
}
function nowSec(){ return Math.floor(Date.now()/1000); }

async function main(){
  const sa = loadSA();
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey) throw new Error('Firebase Web API Key が未設定です（NEXT_PUBLIC_FIREBASE_API_KEY か FIREBASE_WEB_API_KEY）。');

  const clientEmail = sa.client_email;
  let privateKey = sa.private_key;
  if (!clientEmail || !privateKey) throw new Error('SA JSON に client_email / private_key が見つかりません。');

  // 改行が \n で埋め込まれている場合に実際の改行へ
  privateKey = privateKey.replace(/\\n/g, '\n');

  // Firebase Custom Token（JWT）を生成（RS256）
  const iat = nowSec();
  const exp = iat + 60 * 5; // 5分有効
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat, exp,
    uid: UID, // 作成/サインインするユーザーの uid
    // 任意のカスタムクレーム:
    claims: { role: 'admin', user_code: '669933' },
  };
  const toSign = `${b64urlJSON(header)}.${b64urlJSON(payload)}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(toSign);
  signer.end();
  const sig = signer.sign(privateKey);
  const jwt = `${toSign}.${sig.toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}`;

  // Custom Token → ID Token 交換
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: jwt, returnSecureToken: true }),
  });
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    throw new Error(`signInWithCustomToken failed: HTTP ${res.status} ${text}`);
  }
  const json = await res.json();
  const idToken = json.idToken;
  if (!idToken) throw new Error('idToken がレスポンスにありません。');

  fs.writeFileSync(OUT, idToken, { mode: 0o600 });
  console.log(`OK: issued ID token for uid="${UID}". Saved to ${OUT}`);
}

main().catch(e => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
