const PAYJP_SECRET = process.env.PAYJP_SECRET_KEY!;
const API = 'https://api.pay.jp/v1';

function b64(a: string) {
  return Buffer.from(a + ':').toString('base64');
}

export async function payjp(path: string, init?: RequestInit) {
  const headers = {
    Authorization: 'Basic ' + b64(PAYJP_SECRET),
    'Content-Type': 'application/x-www-form-urlencoded',
    ...(init?.headers || {}),
  };
  const res = await fetch(API + path, { ...init, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || `PAY.JP error ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

export function form(data: Record<string, any>) {
  const body = new URLSearchParams();
  Object.entries(data).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    body.append(k, String(v));
  });
  return body;
}
