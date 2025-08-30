import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!; // ← 必須（サーバー専用）
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

export async function POST(req: Request) {
  try {
    const { myCode, threadIds } = await req.json() as { myCode: string; threadIds: string[] };
    if (!myCode || !Array.isArray(threadIds) || threadIds.length === 0) {
      return NextResponse.json({ error: 'bad request' }, { status: 400 });
    }

    // 最新メッセ（全体降順 → 各 thread の最初を採用）
    const { data: latestRows, error: latestErr } = await admin
      .from('chats')
      .select('thread_id, message, body, created_at')
      .in('thread_id', threadIds)
      .order('created_at', { ascending: false });
    if (latestErr) throw latestErr;

    const latestMap: Record<string, { at: string | null; text: string | null }> = {};
    for (const r of (latestRows ?? []) as any[]) {
      const tid = String(r.thread_id);
      if (!latestMap[tid]) {
        latestMap[tid] = {
          at: r.created_at ?? null,
          text: (r.message ?? r.body ?? '') as string,
        };
      }
    }

    // 未読件数（自分宛のみ）
    const { data: unreadAgg, error: unreadErr } = await admin
      .from('chats')
      .select('thread_id, count:count(*)')
      .in('thread_id', threadIds)
      .eq('receiver_code', myCode)
      .is('read_at', null);
    if (unreadErr) throw unreadErr;

    const unreadMap = new Map<string, number>();
    for (const r of (unreadAgg ?? []) as any[]) {
      unreadMap.set(String(r.thread_id), Number(r.count) || 0);
    }

    // 返却
    const result: Record<string, { lastMessageAt: string | null; lastMessageText: string | null; unreadCount: number }> = {};
    for (const tid of threadIds) {
      result[tid] = {
        lastMessageAt: latestMap[tid]?.at ?? null,
        lastMessageText: latestMap[tid]?.text ?? null,
        unreadCount: unreadMap.get(tid) ?? 0,
      };
    }
    return NextResponse.json({ metaByThreadId: result });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
