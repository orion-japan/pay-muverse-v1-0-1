import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ★ 追加：Push関係（あなたのプロジェクトURLに合わせてOK）
const PUSH_FUNC_URL =
  process.env.NEXT_PUBLIC_SUPABASE_FUNCTION_URL ??
  'https://hcodeoathneftqkmjyoh.supabase.co/functions/v1/sendPush';
const SR_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// ★ 追加：TalkのPush送信用ヘルパー（SelfTalkと同じEdge Functionを利用）
async function sendTalkPush(opts: {
  user_code: string; // 受信者
  sender_name?: string | null; // 通知タイトルに使う表示名（なければ sender_code）
  thread_id: string;
  preview: string;
  origin?: string | null; // クリック先の絶対URL生成に使用（なければ相対でもOK）
}) {
  try {
    const title = opts.sender_name ?? '新着メッセージ';
    const body = opts.preview.length > 140 ? opts.preview.slice(0, 140) + '…' : opts.preview;

    const base = opts.origin && /^https?:\/\//.test(opts.origin) ? opts.origin : '';
    const url = `${base}/talk/${encodeURIComponent(opts.thread_id)}`;

    const payload = {
      user_code: opts.user_code,
      title,
      body,
      url,
      tag: `talk-${opts.thread_id}`, // 同一スレッドの通知はまとめる
      renotify: true,
    };

    const res = await fetch(PUSH_FUNC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SR_KEY}`, // Service Role で実行（RLSバイパス）
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.warn('[Talk][push] non-200:', res.status, t);
    } else {
      // 必要なら配信結果をログ
      const j = await res.json().catch(() => null);
      console.log('[Talk][push] ok', j?.results || j);
    }
  } catch (e) {
    console.error('[Talk][push] error', e);
  }
}

// GET /api/talk/messages?thread_id=...&limit=50&cursor=...
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const thread_id = searchParams.get('thread_id') || '';
    const limit = Math.min(Number(searchParams.get('limit') || 50), 200);
    const cursor = searchParams.get('cursor');

    if (!thread_id) {
      return NextResponse.json({ error: 'thread_id required' }, { status: 400 });
    }

    let q = supabaseAdmin
      .from('chats')
      .select('*')
      .eq('thread_id', thread_id)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (cursor) q = q.gt('created_at', cursor);

    const { data, error } = await q;
    if (error) throw error;

    return NextResponse.json({ items: data ?? [] });
  } catch (e: any) {
    console.error('[Talk][GET]', e);
    return NextResponse.json({ error: e?.message || 'unexpected' }, { status: 500 });
  }
}

// POST /api/talk/messages
// body: { a_code, b_code, sender_code, body }
// ※ DB の thread_id は「生成カラム」なので送らない！insert 後に返却値から取得。
export async function POST(req: Request) {
  try {
    const { a_code, b_code, sender_code, body } = await req.json();

    if (!a_code || !b_code || !sender_code || !body) {
      return NextResponse.json({ error: 'bad request' }, { status: 400 });
    }

    const receiver_code = sender_code === a_code ? b_code : a_code;

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('chats')
      .insert({
        sender_code,
        receiver_code,
        message: body, // ← DB カラム名は message
      })
      .select('thread_id')
      .single();
    if (insErr) throw insErr;

    const finalThreadId = inserted?.thread_id as string;

    // 任意：スレッドメタ更新（エラーは致命的でないので await のまま／catchは不要でもOK）
    await supabaseAdmin.from('chat_threads').upsert(
      {
        thread_id: finalThreadId,
        a_code,
        b_code,
        last_message: String(body).slice(0, 200),
        last_message_at: new Date().toISOString(),
      },
      { onConflict: 'thread_id' },
    );

    // ★ 追加：受信者にTalk通知を送る（自分宛ては送らない）
    if (receiver_code && receiver_code !== sender_code) {
      const origin =
        req.headers.get('origin') ||
        process.env.NEXT_PUBLIC_SITE_ORIGIN || // 任意：環境変数で絶対URLを指定できる
        null;
      // 送信者名を付けたい場合、profiles から取得も可能（必要なら追記）
      await sendTalkPush({
        user_code: receiver_code,
        sender_name: sender_code, // 表示名を使いたければここを変更
        thread_id: finalThreadId,
        preview: String(body),
        origin,
      });
    }

    return NextResponse.json({ ok: true, thread_id: finalThreadId });
  } catch (e: any) {
    console.error('[Talk][POST]', e);
    return NextResponse.json({ error: e?.message || 'unexpected', details: e }, { status: 500 });
  }
}
