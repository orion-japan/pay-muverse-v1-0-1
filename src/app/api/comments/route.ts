// src/app/api/comments/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

// ========= 型 =========
type Body = {
  post_id?: string;
  user_code?: string;
  content?: string;
};

// ========= ユーティリティ =========
// 実行環境から自分自身の絶対URLを推定（HOME_URL > NEXT_PUBLIC_SITE_URL > req.origin）
function getBaseUrl(req: NextRequest) {
  const envBase = process.env.HOME_URL || process.env.NEXT_PUBLIC_SITE_URL || '';
  if (envBase) return envBase.replace(/\/+$/, '');
  return req.nextUrl.origin.replace(/\/+$/, '');
}

// /api/push/send をベストエフォートで叩く
async function sendPush(
  baseUrl: string,
  params: {
    to: string; // user_code
    title: string;
    body: string;
    url: string; // 相対でもOK（SW側で origin 補完）
    kind?: 'rtalk' | 'generic';
    tag?: string; // 同一スレ上書き
    renotify?: boolean;
  },
) {
  try {
    const endpoint = new URL('/api/push/send', baseUrl).toString();
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        user_code: params.to,
        kind: params.kind ?? 'generic',
        title: params.title,
        body: params.body,
        url: params.url,
        tag: params.tag,
        renotify: params.renotify ?? true,
      }),
    });
  } catch {
    // ベストエフォート：失敗しても無視
  }
}

// ========= ハンドラ =========
export async function POST(req: NextRequest) {
  const rid = `cmt_post_${Math.random().toString(36).slice(2, 9)}`;

  try {
    const { post_id, user_code, content } = (await req.json()) as Body;

    // バリデーション
    if (!post_id || !user_code || !content?.trim()) {
      return NextResponse.json({ ok: false, error: 'bad request', rid }, { status: 400 });
    }

    // Supabase（管理権限：SRKがあればSRK、無ければAnon）
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    // 1) コメントを挿入
    const { data: inserted, error: insErr } = await admin
      .from('post_comments')
      .insert({
        post_id: String(post_id),
        user_code: String(user_code),
        content: content.trim(),
      })
      .select('comment_id, post_id, user_code, content, created_at')
      .single();

    if (insErr) {
      return NextResponse.json({ ok: false, error: insErr.message, rid }, { status: 500 });
    }

    // 2) 受信者の算出（投稿主 + 既存コメ参加者 － 自分）
    //    投稿主
    const { data: postRow } = await admin
      .from('posts')
      .select('user_code, title')
      .eq('post_id', String(post_id))
      .single();

    //    既存コメ参加者
    const { data: commenterRows } = await admin
      .from('post_comments')
      .select('user_code')
      .eq('post_id', String(post_id));

    const recipients = new Set<string>();
    if (postRow?.user_code) recipients.add(postRow.user_code);
    commenterRows?.forEach((r: any) => {
      if (r?.user_code) recipients.add(String(r.user_code));
    });
    recipients.delete(String(user_code)); // 自分除外

    // 3) Push送信（ベストエフォート）
    if (recipients.size > 0) {
      const baseUrl = getBaseUrl(req);
      const preview = content.trim().slice(0, 80);
      const title = postRow?.title ? `「${postRow.title}」に新しいコメント` : '新しいコメント';
      const url = `/board/${post_id}?focus=comments`;
      const tag = `post-${post_id}`; // 同一投稿内は上書き

      await Promise.allSettled(
        [...recipients].map((to) =>
          sendPush(baseUrl, {
            to,
            title,
            body: preview,
            url,
            kind: 'generic',
            tag,
            renotify: true,
          }),
        ),
      );
    }

    return NextResponse.json(
      { ok: true, table: 'post_comments', data: inserted, rid },
      { status: 201 },
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? 'internal error', rid },
      { status: 500 },
    );
  }
}
