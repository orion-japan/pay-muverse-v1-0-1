import { NextRequest, NextResponse } from 'next/server';

const MU_API_BASE = (process.env.MU_API_BASE ?? 'https://m.muverse.jp').trim().replace(/\/+$/, '');
const MU_TIMEOUT_MS = 12000;
const MU_PREFIX = `${MU_API_BASE}/api`;

async function postJson(url: string, body: any, signal: AbortSignal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    cache: 'no-store',
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { res, text, data };
}

// ★ MUの返却をフラット化して user_code を必ずトップに
function normalizeMu(data: any) {
  if (!data) return null;
  const userObj = data.user ?? data; // {"user":{...}} or 直接 {...}
  if (!userObj || !userObj.user_code) return null;
  // フラットな形にして返す（必要なキーはご自由に）
  return {
    user_code: userObj.user_code,
    click_email: userObj.click_email,
    card_registered: userObj.card_registered,
    payjp_customer_id: userObj.payjp_customer_id,
    click_type: userObj.click_type,
    sofia_credit: userObj.sofia_credit,
    // 元データも一応保持したい場合:
    raw: data,
  };
}

export async function POST(req: NextRequest) {
  try {
    const { token } = await req.json().catch(() => ({}));
    if (typeof token !== 'string' || token.length < 100) {
      return NextResponse.json({ ok: false, error: 'INVALID_TOKEN' }, { status: 400 });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MU_TIMEOUT_MS);
    const url = `${MU_PREFIX}/get-user-info`;

    // まずは MU が受け付ける { idToken } で送る
    let { res, text, data } = await postJson(url, { idToken: token }, controller.signal);
    console.log('[call-mu-ai] try#1 status:', res.status, 'url:', url, 'body:', text);

    // 400なら旧形式でも試す（将来互換）
    if (res.status === 400) {
      ({ res, text, data } = await postJson(url, { auth: { mode: 'firebase', idToken: token } }, controller.signal));
      console.log('[call-mu-ai] try#2 status:', res.status, 'url:', url, 'body:', text);
    }

    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: 'MU_FORWARD_FAILED', debug: { status: res.status, url, body: text } },
        { status: 502 }
      );
    }

    const mu = normalizeMu(data);
    if (!mu) {
      return NextResponse.json(
        { ok: false, error: 'MU_NO_USER_CODE', mu: data, debug: { url } },
        { status: 502 }
      );
    }

    // ここで mu.user_code がトップに来ている
    return NextResponse.json({ ok: true, mu }, { status: 200 });
  } catch (e: any) {
    console.error('[call-mu-ai] unexpected error:', e?.message || e);
    return NextResponse.json({ ok: false, error: 'INTERNAL' }, { status: 500 });
  }
}
