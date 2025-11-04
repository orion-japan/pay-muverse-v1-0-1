import crypto from 'crypto';

/** 署名 (HMAC-SHA256) を生成 */
export function signQuery(base: string, secret: string) {
  return crypto.createHmac('sha256', secret).update(base).digest('hex');
}

/** user_code + ts の署名ペアを返す（有効期限は MU 側で ts 検証） */
export function makeSignedParams(user_code: string, secret: string) {
  const ts = Math.floor(Date.now() / 1000); // 秒
  const base = `ts=${ts}&user_code=${user_code}`;
  const sig = signQuery(base, secret);
  return { ts, sig };
}
