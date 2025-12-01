// src/app/api/agent/iros/analyze/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const sb = () => createClient(SUPABASE_URL!, SERVICE_ROLE!);

const json = (data: any, status = 200) =>
  new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });

type AnalyzeOut = {
  polarity: number; // -1..+1
  sa: number;       // 0..1  (self-acceptance 推定)
  q_primary: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  phase: 'Inner' | 'Outer';
  layer: 'S1' | 'R1' | 'C1' | 'I1';
};

// ---- 簡易スコア（オウム返し対策：保存はしない・assistantで挿入しない）----
const NEG = ['つらい','不安','怖い','無理','嫌','怒り','疲れ','しんどい','泣'];
const POS = ['嬉しい','安心','好き','大丈夫','楽しい','幸せ','助かる','ありがとう'];
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function estimatePolarity(t: string): number {
  const p = POS.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
  const n = NEG.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
  if (p === 0 && n === 0) return 0;
  return (p - n) / (p + n);
}
function estimateSelfAcceptance(t: string): number {
  const self = ['私','わたし','自分','僕','わたくし'];
  const accept = ['大丈夫','受け入れる','許す','落ち着く','呼吸'];
  const deny = ['無理','ダメ','できない','嫌い','否定'];
  const s = self.some((w) => t.includes(w)) ? 0.1 : 0;
  const a = accept.reduce((acc, w) => acc + (t.includes(w) ? 0.15 : 0), 0);
  const d = deny.reduce((acc, w) => acc + (t.includes(w) ? 0.15 : 0), 0);
  return clamp01(0.5 + s + a - d);
}
function estimateQ(t: string): AnalyzeOut['q_primary'] {
  if (/(怒り|成長|挑戦|突破)/.test(t)) return 'Q2';
  if (/(不安|安定|迷い|疑い)/.test(t)) return 'Q3';
  if (/(恐れ|浄化|手放す|清め)/.test(t)) return 'Q4';
  if (/(情熱|空虚|燃える|衝動)/.test(t)) return 'Q5';
  return 'Q1';
}
function estimatePhase(t: string): AnalyzeOut['phase'] {
  const i = ['感じ','内面','心','内観','静けさ'];
  const o = ['相手','仕事','世界','関係','環境'];
  const ic = i.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
  const oc = o.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
  return ic >= oc ? 'Inner' : 'Outer';
}
function estimateLayer(t: string): AnalyzeOut['layer'] {
  if (/(祈り|存在|意図|源|本質)/.test(t)) return 'I1';
  if (/(創る|設計|表現|構築)/.test(t)) return 'C1';
  if (/(関係|共鳴|つながり|場)/.test(t)) return 'R1';
  return 'S1';
}

export async function OPTIONS() {
  return json({ ok: true });
}

/** --------------------
 * POST /api/agent/iros/analyze
 * 本文: {
 *   conversation_id: string,
 *   text: string,                 // 解析対象（ユーザー発話など）
 *   persist?: boolean,            // 解析結果を iros_analysis に保存する場合 true（既定: false）
 * }
 * 動作:
 *   - 認証＋会話所有者の確認
 *   - テキストを解析し、{ polarity, sa, q_primary, phase, layer } を返す
 *   - ※ メッセージテーブルには一切書き込まない（オウム返し原因の排除）
 *   - persist=true かつ iros_analysis テーブルが存在する場合のみ保存を試みる
 * -------------------- */
export async function POST(req: NextRequest) {
  try {
    const authz = await verifyFirebaseAndAuthorize(req);
    if (!authz.ok)
      return json({ ok: false, error: authz.error || 'unauthorized' }, authz.status || 401);
    if (!authz.allowed) return json({ ok: false, error: 'forbidden' }, 403);

    const userCode: string =
      (typeof authz.user === 'string' && authz.user) ||
      (typeof (authz.user as any)?.user_code === 'string' && (authz.user as any).user_code) ||
      (authz as any)?.userCode ||
      (authz as any)?.jwt?.sub ||
      '';
    if (!userCode) return json({ ok: false, error: 'user_code_missing' }, 400);

    let body: any = {};
    try { body = await req.json(); } catch { /* noop */ }

    const conversation_id: string = String(body?.conversation_id || body?.conversationId || '').trim();
    const text: string = String(body?.text ?? '').trim();
    const persist: boolean = Boolean(body?.persist ?? false);

    if (!conversation_id) return json({ ok: false, error: 'missing_conversation_id' }, 400);
    if (!text) return json({ ok: false, error: 'text_empty' }, 400);

    const supabase = sb();

    // 所有者チェック（必須）
    const { data: conv, error: convErr } = await supabase
      .from('iros_conversations')
      .select('id,user_code')
      .eq('id', conversation_id)
      .maybeSingle();

    if (convErr) return json({ ok: false, error: 'conv_select_failed', detail: convErr.message }, 500);
    if (!conv) return json({ ok: false, error: 'conversation_not_found' }, 404);
    if (String(conv.user_code) !== String(userCode))
      return json({ ok: false, error: 'forbidden_owner_mismatch' }, 403);

    // 解析（保存しない）
    const out: AnalyzeOut = {
      polarity: estimatePolarity(text),
      sa: estimateSelfAcceptance(text),
      q_primary: estimateQ(text),
      phase: estimatePhase(text),
      layer: estimateLayer(text),
    };

    // 任意で iros_analysis（存在する場合のみ）に保存
    if (persist) {
      try {
        const nowIso = new Date().toISOString();
        await supabase
          .from('iros_analysis')
          .insert([{
            conversation_id,
            user_code: userCode,
            source_role: 'user',
            source_text: text,
            polarity: out.polarity,
            sa: out.sa,
            q_primary: out.q_primary,
            phase: out.phase,
            layer: out.layer,
            created_at: nowIso,
          }]);
        // テーブル未存在や列不一致のエラーは握りつぶす（環境差吸収）
      } catch {
        /* noop */
      }
    }

    return json({ ok: true, ...out }, 200);
  } catch (e: any) {
    return json({ ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) }, 500);
  }
}
