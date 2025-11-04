// src/app/api/agent/mtalk/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE, verifyFirebaseAndAuthorize } from '@/lib/authz';
import { generateMirraReply } from '@/lib/mirra/generate'; // ★ generate.ts を使う
import { recordQ } from '@/lib/qcode/record'; // ★ 追加：Qコード記録の共通口

function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : ((init as ResponseInit | undefined)?.['status'] ?? 200);
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

export async function POST(req: NextRequest) {
  try {
    // ---- 認証 ----
    const auth = await verifyFirebaseAndAuthorize(req as any);
    if (!auth?.ok)
      return json({ ok: false, error: auth?.error || 'unauthorized' }, auth?.status || 401);
    if (!auth.allowed) return json({ ok: false, error: 'forbidden' }, 403);

    // ---- 入力 ----
    const body = await req.json().catch(() => ({}));
    const text: string = String(body.text ?? body.message ?? '').trim();
    if (!text) return json({ ok: false, error: 'empty' }, 400);

    // 👇 修正版（null 安全に取得）
    const user_code: string | null =
      (body.user_code as string | undefined) ?? auth.userCode ?? auth.user?.user_code ?? null;

    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const conversation_id: string = String(
      body.thread_id ?? body.conversation_id ?? `mirra-${user_code}`,
    );

    const supa = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
      auth: { persistSession: false },
    });

    // ---- スレッド upsert（存在しなければ作る）----
    {
      const { error } = await supa.from('talk_threads').upsert(
        {
          id: conversation_id,
          user_a_code: user_code,
          agent: 'mirra',
          created_by: user_code,
          title: 'mirra 会話',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' },
      );
      if (error) {
        console.error('[mtalk] upsert thread error:', error);
        // ここで落とさず続行（メッセージ記録はできるため）
      }
    }

    const nowISO = new Date().toISOString();

    // ---- ユーザー発話を保存（talk_messages）----
    {
      const { error } = await supa.from('talk_messages').insert([
        {
          thread_id: conversation_id, // 既存UIが読むキー
          sender_code: user_code,
          user_code,
          role: 'user',
          content: text,
          created_at: nowISO,
        },
      ]);
      if (error) {
        console.error('[mtalk] insert user msg error:', error);
        return json({ ok: false, error: error.message }, 500);
      }
    }

    // ---- 直近の履歴を取得（last assistant を anti-repeat へ）----
    const { data: hist, error: hErr } = await supa
      .from('talk_messages')
      .select('role, content, created_at')
      .eq('thread_id', conversation_id)
      .order('created_at', { ascending: true })
      .limit(60);
    if (hErr) console.warn('[mtalk] history warn:', hErr.message);

    const lastAssistantReply =
      [...(hist ?? [])].reverse().find((m) => String(m.role) === 'assistant')?.content ?? null;

    // ---- seed（mTalkの黒カード起点）候補を収集 ----
    // 1) その会話に紐づいた最新レポート
    let seed: string | null = null;
    try {
      const { data: rep } = await supa
        .from('mtalk_reports')
        .select('reply_text')
        .eq('conversation_id', conversation_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (rep?.reply_text) seed = String(rep.reply_text);
    } catch {}

    // 2) conversations.messages の先頭2つ（consultで入れた problem/answer）をフォールバックで連結
    if (!seed) {
      try {
        const { data: conv } = await supa
          .from('conversations')
          .select('messages')
          .eq('id', conversation_id)
          .maybeSingle();
        const arr = Array.isArray((conv as any)?.messages) ? ((conv as any).messages as any[]) : [];
        if (arr.length >= 2) {
          const u = (arr.find((m) => m.role === 'user')?.content || '').toString();
          const a = (arr.find((m) => m.role === 'assistant')?.content || '').toString();
          const joined = [u, a].filter(Boolean).join('\n');
          if (joined) seed = joined.slice(0, 600);
        }
      } catch {}
    }

    // ---- mirra 応答生成：ここから generate.ts を必ず通す ----
    const out = await generateMirraReply(
      text,
      seed,
      lastAssistantReply,
      'consult',
      conversation_id,
    );

    // ---- 応答を保存（talk_messages）----
    {
      const { error } = await supa.from('talk_messages').insert([
        {
          thread_id: conversation_id,
          sender_code: 'mirra',
          role: 'assistant',
          content: out.text,
          meta: out.meta,
          created_at: new Date().toISOString(),
        },
      ]);
      if (error) console.error('[mtalk] insert assistant msg error:', error);
    }

    // ---- ★ Qコード記録（非致命）----
    try {
      const qres = {
        ts: new Date().toISOString(),
        currentQ: out?.meta?.currentQ ?? out?.meta?.current_q ?? null,
        depthStage: out?.meta?.depthStage ?? out?.meta?.depth_stage ?? 'S1',
        phase: out?.meta?.phase ?? 'Inner',
        self: out?.meta?.selfAcceptance ?? null,
        relation: out?.meta?.relation ?? null,
        confidence:
          typeof out?.meta?.relation?.confidence === 'number'
            ? out.meta.relation.confidence
            : undefined,
        hint: out?.meta?.analysis?.keyword ?? null,
        source: { type: 'mirra', model: out?.meta?.charge?.model ?? 'gpt-4o', version: '1' },
        conversation_id,
        message_id: null,
      };

      // ▼ 余剰プロパティチェック回避（型が古い参照でも落ちないように）
      const recArgs: any = {
        user_code,
        source_type: 'mirra',
        intent: 'chat',
        qres,
      };
      await recordQ(recArgs);
    } catch (e) {
      console.warn('[mtalk] recordQ skipped:', (e as any)?.message || e);
    }

    // ---- スレッド更新 ----
    await supa
      .from('talk_threads')
      .update({
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation_id);

    // ---- クレジット消費（存在しない環境はスキップ）----
    let balance_after: number | null = null;
    try {
      const { error: rpcErr } = await supa.rpc('fn_charge_credits', {
        p_user_code: user_code,
        p_cost: 1,
        p_reason: 'mirra_chat_turn',
        p_meta: { agent: 'mirra', conversation_id },
        p_ref_conversation_id: conversation_id,
        p_ref_sub_id: null,
      });
      if (rpcErr) {
        // 旧名 fallback
        const { error: altErr } = await supa.rpc('credit_capture', {
          p_user_code: user_code,
          p_amount: 1,
          p_reason: 'mirra_chat_turn',
          p_source_kind: 'agent',
          p_source_id: 'mirra',
          p_action: 'chat_turn',
          p_idempotency_key: `mirra:${conversation_id}:${Date.now()}`,
        });
        if (altErr) console.warn('[mtalk] credit rpc warn:', altErr.message);
      }
      // 残高
      const { data: u, error: uErr } = await supa
        .from('users')
        .select('sofia_credit')
        .eq('user_code', user_code)
        .maybeSingle();
      if (!uErr && u && typeof u.sofia_credit === 'number') balance_after = Number(u.sofia_credit);
    } catch (e) {
      console.warn('[mtalk] credit charge skipped:', (e as any)?.message || e);
    }

    return json({
      ok: true,
      route: 'api/agent/mtalk',
      agent: 'mirra',
      conversation_id,
      thread_id: conversation_id,
      reply: out.text,
      meta: out.meta,
      credit_balance: balance_after,
      used_fallback: out.meta?.provider === 'fallback',
    });
  } catch (e: any) {
    console.error('[mtalk] error', e);
    return json({ ok: false, error: 'internal_error', detail: String(e?.message || e) }, 500);
  }
}
