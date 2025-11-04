// src/lib/mui/charge.ts

/** ========== クライアント: PAY.JP v2 のカードUI/トークン化 ========== */

// PAY.JP の CDN スクリプトを動的ロード（クライアント専用）
function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new Error('document is undefined (server)'));
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

let _payjp: PayjpInstance | null = null;

/** ブラウザで PAY.JP を初期化 */
export async function ensurePayjp(): Promise<PayjpInstance> {
  if (_payjp) return _payjp;

  const pk = process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY;
  if (!pk) throw new Error('Missing NEXT_PUBLIC_PAYJP_PUBLIC_KEY');

  await loadScript('https://js.pay.jp/v2/');

  const inst = (window as any).Payjp?.(pk) as PayjpInstance | undefined;
  if (!inst) throw new Error('window.Payjp not found');
  _payjp = inst;
  return _payjp!;
}

/** 指定DOMにカード要素をマウントしてトークンを作る（クライアント） */
export async function createCardToken(mountSelector: string, email?: string): Promise<string> {
  if (typeof window === 'undefined') throw new Error('createCardToken must run in browser');
  const payjp = await ensurePayjp();
  const elements = payjp.elements();
  const card = elements.create('card');

  const mount = document.querySelector(mountSelector) as HTMLElement | null;
  if (!mount) throw new Error(`mount not found: ${mountSelector}`);
  mount.innerHTML = ''; // 再マウント対策
  // @ts-ignore PAY.JP card element
  card.mount(mountSelector);

  const r = await payjp.createToken(card, email ? { email } : undefined);
  if (r?.error) throw new Error(r.error.message || 'tokenize failed');
  if (!r?.id) throw new Error('token not returned');
  return r.id;
}

/** ========== サーバ: 1ターン課金の実行（PAY.JP Charges API） ========== */
/**
 * 使い方（サーバから呼ぶ）:
 *   const r = await chargeOneTurn({
 *     amount: 980,           // 税込 日本円
 *     token: 'tok_xxx',      // createCardToken で得たトークン
 *     description: 'Mui フェーズ3',
 *     idempotencyKey: 'CASE-20251013-ABCD-Q2' // 任意（重複課金防止）
 *   })
 */
export async function chargeOneTurn(params: {
  amount: number; // 例: 280 / 980 / 1980
  token: string; // PAY.JP の card トークン
  description?: string;
  idempotencyKey?: string; // 同一リクエストの重複防止に推奨
}): Promise<{ ok: true; chargeId: string; raw: any } | { ok: false; error: string }> {
  if (typeof window !== 'undefined') {
    return { ok: false, error: 'chargeOneTurn must run on server' };
  }

  const secret = process.env.PAYJP_SECRET_KEY;
  if (!secret) return { ok: false, error: 'Missing PAYJP_SECRET_KEY' };

  // Node で Basic 認証ヘッダを作る
  const basic = Buffer.from(`${secret}:`).toString('base64');

  // PAY.JP Charges API
  const body = new URLSearchParams();
  body.set('amount', String(params.amount));
  body.set('currency', 'jpy'); // デフォルト: jpy
  body.set('card', params.token); // card にトークンを渡す
  if (params.description) body.set('description', params.description);

  const headers: Record<string, string> = {
    Authorization: `Basic ${basic}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (params.idempotencyKey) headers['Idempotency-Key'] = params.idempotencyKey;

  const res = await fetch('https://api.pay.jp/v1/charges', {
    method: 'POST',
    headers,
    body,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText || 'charge failed';
    return { ok: false, error: msg };
  }
  return { ok: true, chargeId: json.id, raw: json };
}
