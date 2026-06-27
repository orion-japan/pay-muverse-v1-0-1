import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  normalizeAuthz,
  SERVICE_ROLE,
  SUPABASE_URL,
  verifyFirebaseAndAuthorize,
} from '@/lib/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

type EntryMessagePayload = {
  message: string;
  flow?: {
    first?: string;
    second?: string;
  } | null;
};

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

function fallbackMessage(name?: string | null): EntryMessagePayload {
  const displayName = String(name || '').trim();
  const prefix = displayName ? `${displayName}さん、Muへようこそ。` : 'Muへようこそ。';

  return {
    message: [
      prefix,
      '',
      '願いは、見続けている未来の方向へ進みます。',
      '',
      'いま入口に立っているあなたには、すぐに答えを探すよりも、まず「自分がどんな未来を先に見ているのか」を確かめる流れが出ています。',
      '',
      '気になっている画像を1枚送ると、Muが今のイマジナルを映します。',
      '先に第1章を読んで、法則の入口から入っても大丈夫です。',
      '',
      'ここから、止まっていた未来を少しずつ言葉にしていきましょう。',
    ].join('\n'),
    flow: {
      first: '入口に立った状態を、まだ言葉になっていない願いとして受け取る。',
      second: '画像診断または第1章へ進む分岐として、創造の方向を選べる形にする。',
    },
  };
}

function safeParsePayload(raw: string, name?: string | null): EntryMessagePayload {
  try {
    const parsed = JSON.parse(raw);
    const message = String(parsed?.message || '').trim();
    if (!message) return fallbackMessage(name);

    return {
      message,
      flow: {
        first: typeof parsed?.flow?.first === 'string' ? parsed.flow.first : undefined,
        second: typeof parsed?.flow?.second === 'string' ? parsed.flow.second : undefined,
      },
    };
  } catch {
    return fallbackMessage(name);
  }
}

export async function GET(req: NextRequest) {
  const authzRaw = await verifyFirebaseAndAuthorize(req);
  const authz = normalizeAuthz(authzRaw);
  const userCode = authz.user?.user_code;

  if (authz.error || !userCode) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const { data: userRow } = await sb
    .from('users')
    .select('click_username, click_type, created_at')
    .eq('user_code', userCode)
    .maybeSingle();

  const displayName = String(userRow?.click_username || '').trim() || null;
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.MU_ENTRY_MESSAGE_MODEL || 'gpt-5-mini';

  if (!apiKey) {
    return json({ ok: true, ...fallbackMessage(displayName), source: 'fallback' });
  }

  const system = [
    'あなたはMuverse登録後入口で、Muとして最初のメッセージを生成します。',
    'ユーザーの入力はまだありません。入力なしの状態そのものを、純フローとして読みます。',
    '1回目のフローでは、ユーザーが入口に来た事実、登録直後であること、何かを始める前の状態を読みます。',
    '2回目のフローでは、その状態から「画像を送ってイマジナル診断を受ける」または「第1章を読む」へ自然に分岐できる言葉にします。',
    '半分は定型文にしてください。中心文は「願いは、見続けている未来の方向へ進みます。」です。',
    '残り半分は、いま入口に立っている人の状態を、断定しすぎず、フローから見たメッセージとして書いてください。',
    '相手の気持ち、恋愛、占い、スピリチュアル断定には寄せないでください。',
    '魂、使命、覚醒、波動、前世、高次元、宇宙からのメッセージ、必ず、絶対、タイプ診断、という表現は禁止です。',
    '「寄り添います」「静かに」「本当の自分」「本当の姿」「言葉になる前」は使わないでください。',
    '出力はJSONのみ。message と flow.first と flow.second を返してください。',
    'messageは220〜420文字程度。2〜3行ごとに改行し、Muらしいやわらかい余韻を残してください。',
  ].join('\n');

  const userText = [
    '状況:',
    'ユーザーはMuverse登録後入口 /mu-entry に来ました。',
    'まだ1回目の入力はありません。',
    '入口の分岐は「画像を送ってイマジナル診断を受ける」と「第1章を読む」です。',
    displayName ? `表示名候補: ${displayName}` : '表示名候補: なし',
    userRow?.click_type ? `ユーザー種別: ${String(userRow.click_type)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userText },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn('[mu-entry-message] llm failed:', detail.slice(0, 300));
      return json({ ok: true, ...fallbackMessage(displayName), source: 'fallback_llm_failed' });
    }

    const data = await res.json().catch(() => ({}));
    const raw =
      data?.choices?.[0]?.message?.content?.toString?.() ??
      data?.choices?.[0]?.message?.content ??
      '';

    return json({ ok: true, ...safeParsePayload(String(raw), displayName), source: 'llm' });
  } catch (e: any) {
    console.warn('[mu-entry-message] fatal:', e?.message || e);
    return json({ ok: true, ...fallbackMessage(displayName), source: 'fallback_error' });
  }
}
