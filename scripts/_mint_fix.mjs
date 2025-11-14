// file: scripts/_mint_fix.mjs
// 用途: Firebase Custom Token -> ID Token を取得して /tmp/_IDTOKEN に保存
// 必要ENV:
//   FIREBASE_WEB_API_KEY          (必須: Web API Key)
//   FIREBASE_PROJECT_ID           (どちらかでOK: これ or GOOGLE_APPLICATION_CREDENTIALS で自動解決)
//   FIREBASE_CLIENT_EMAIL         (サービスアカウントの client_email)
//   FIREBASE_PRIVATE_KEY          (-----BEGIN PRIVATE KEY----- から END... まで。\\n は実改行に置換)
// もしくは GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json でも可（Admin初期化に使用）
//
// 付与するカスタムクレーム:
//   role=admin, user_code=669933

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import { initializeApp, applicationDefault, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
if (!WEB_API_KEY) {
  console.error('ERROR: FIREBASE_WEB_API_KEY is required');
  process.exit(1);
}

// Admin SDK init（ADC or 明示 cert）
function initAdmin() {
  if (getApps().length) return;
  const hasADC = !!process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const hasInline =
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY;

  if (hasADC) {
    initializeApp({ credential: applicationDefault() });
    return;
  }
  if (hasInline) {
    const pk = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: pk,
      }),
    });
    return;
  }
  console.error('ERROR: Provide GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY');
  process.exit(1);
}

async function main() {
  initAdmin();
  const auth = getAuth();

  // 任意のUID（固定でOK）。ここでは "uc-669933"
  const uid = 'uc-669933';
  const claims = { role: 'admin', user_code: '669933' };

  // 1) Custom token を発行
  const customToken = await auth.createCustomToken(uid, claims);

  // 2) REST で custom token を ID token に交換
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });

  if (!r.ok) {
    const text = await r.text();
    console.error('ERROR: signInWithCustomToken failed', r.status, text);
    process.exit(1);
  }

  const j = await r.json();
  const idToken = j.idToken;
  const refreshToken = j.refreshToken; // 必要なら保存
  const expiresIn = Number(j.expiresIn || 3600);

  // 3) /tmp/_IDTOKEN に保存
  const outFile = '/tmp/_IDTOKEN';
  fs.writeFileSync(outFile, idToken, { mode: 0o600 });

  // 4) 確認用に payload を表示
  const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
  const exp = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;

  console.log(JSON.stringify({
    ok: true,
    saved: outFile,
    exp,
    claims: { role: payload.role, user_code: payload.user_code, provider: payload?.firebase?.sign_in_provider || null },
  }, null, 2));
}

main().catch((e) => {
  console.error('ERROR:', e?.message || e);
  process.exit(1);
});
