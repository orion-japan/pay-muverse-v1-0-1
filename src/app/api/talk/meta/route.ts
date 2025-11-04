import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

type MetaRow = {
  thread_id: string;
  last_message_at: string | null;
  last_message_text: string | null;
  unread: number;
};

export async function POST(req: NextRequest) {
  try {
    const { myCode, threadIds } = (await req.json()) as { myCode: string; threadIds: string[] };
    if (!myCode || !Array.isArray(threadIds) || threadIds.length === 0) {
      return NextResponse.json(
        { metaByThreadId: {} },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // mirra-* は除外（念のため）
    const ids = threadIds.filter((id) => !/^mirra-/.test(id));
    if (ids.length === 0) {
      return NextResponse.json(
        { metaByThreadId: {} },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // まとめて取得：最後のメッセージと未読件数
    // 未読の条件:
    //   - thread_id 一致
    //   - sender_code <> myCode（自分が送った分は未読ではない）
    //   - created_at > last_read_at（自分の既読時刻より新しい）
    // last_read_at は talk_reads(thread_id, user_code) を参照、無ければ epoch とみなす
    const sql = `
      with latest as (
        select c.thread_id,
               max(c.created_at) as last_message_at,
               -- 最終メッセージ本文（同時刻同列対応のため array_agg → last）
               (array_agg(c.content order by c.created_at))[array_length(array_agg(c.content),1)] as last_message_text
        from public.chats c
        where c.thread_id = any(:ids)
          and c.thread_id not like 'mirra-%'
        group by c.thread_id
      ),
      r as (
        select thread_id,
               coalesce(max(last_read_at), to_timestamp(0)) as last_read_at
        from public.talk_reads
        where user_code = :me
          and thread_id = any(:ids)
        group by thread_id
      )
      select
        c.thread_id,
        l.last_message_at,
        l.last_message_text,
        count(*) filter (
          where c.sender_code <> :me
            and c.created_at > coalesce(r.last_read_at, to_timestamp(0))
        ) as unread
      from public.chats c
      left join r on r.thread_id = c.thread_id
      left join latest l on l.thread_id = c.thread_id
      where c.thread_id = any(:ids)
        and c.thread_id not like 'mirra-%'
      group by c.thread_id, l.last_message_at, l.last_message_text
    `;

    const { data, error } = await sb.rpc('sql', { sql, params: { ids, me: myCode } });
    if (error) {
      console.warn('[meta] rpc error:', error);
      return NextResponse.json(
        { metaByThreadId: {} },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const rows = (data as MetaRow[]) ?? [];
    const metaByThreadId: Record<
      string,
      { lastMessageAt: string | null; lastMessageText: string | null; unreadCount: number }
    > = {};
    for (const r of rows) {
      metaByThreadId[r.thread_id] = {
        lastMessageAt: r.last_message_at,
        lastMessageText: r.last_message_text,
        unreadCount: Math.max(0, Number(r.unread || 0)),
      };
    }

    return NextResponse.json(
      { metaByThreadId },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('[meta] fatal', e);
    return NextResponse.json(
      { metaByThreadId: {} },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
