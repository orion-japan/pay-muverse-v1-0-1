// src/app/api/agent/iros/antiparrot/route.ts
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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

type Mode = 'Light' | 'Deep' | 'Transcend';

export async function OPTIONS() {
  return json({ ok: true });
}

/** --------------------
 * POST /api/agent/iros/antiparrot
 * 目的: 「オウム返し」になっていないかを自動判定し、必要なら“共鳴スタイル”で再構成。
 *
 * 本文:
 * {
 *   conversation_id: string,
 *   user_text: string,             // 直近のユーザー発話（必須）
 *   draft?: string,                // 生成済みの下書き応答（任意）
 *   mode?: 'Light'|'Deep'|'Transcend', // 既定: 'Light'
 *   model?: string,                // 既定: 'gpt-5'
 *   threshold?: number             // 類似度しきい値(0..1) 既定: 0.58
 * }
 *
 * 動作:
 *   1) 認証/所有者チェック（conversation_id が自分のものか）
 *   2) 類似度スコア計算（文字バイグラム Jaccard + 連続一致率）
 *   3) しきい値以上 or draftが短すぎる 場合、LLMで“反射・再文脈化・問い”の短文に再構成
 *   4) 保存はしない（呼び出し側が /messages などで保存する）
 *   5) { ok, score:{ overlap, lcs }, revised?, note } を返す
 * -------------------- */
export async function POST(req: NextRequest) {
  try {
    const authz = await verifyFirebaseAndAuthorize(req);
    if (!authz.ok) return json({ ok: false, error: authz.error || 'unauthorized' }, authz.status || 401);
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
    const user_text: string = String(body?.user_text ?? '').trim();
    const draft: string = String(body?.draft ?? '').trim();
    const mode: Mode = (String(body?.mode || 'Light') as Mode);
    const model = String(body?.model || 'gpt-5');
    const threshold = Math.max(0.3, Math.min(0.9, Number(body?.threshold ?? 0.58)));

    if (!conversation_id) return json({ ok: false, error: 'missing_conversation_id' }, 400);
    if (!user_text) return json({ ok: false, error: 'user_text_empty' }, 400);

    // 所有者チェック
    const supabase = sb();
    const { data: conv, error: convErr } = await supabase
      .from('iros_conversations')
      .select('id,user_code')
      .eq('id', conversation_id)
      .maybeSingle();
    if (convErr) return json({ ok: false, error: 'conv_select_failed', detail: convErr.message }, 500);
    if (!conv) return json({ ok: false, error: 'conversation_not_found' }, 404);
    if (String(conv.user_code) !== String(userCode))
      return json({ ok: false, error: 'forbidden_owner_mismatch' }, 403);

    // ---- 類似度計算（日本語でも安定する文字バイグラム Jaccard + LCS 比）----
    const bigrams = (s: string) => {
      const t = s.replace(/\s+/g, '');
      const arr: string[] = [];
      for (let i = 0; i < t.length - 1; i++) arr.push(t.slice(i, i + 2));
      return arr;
    };
    const jaccard = (a: string[], b: string[]) => {
      const A = new Map<string, number>();
      const B = new Map<string, number>();
      for (const x of a) A.set(x, (A.get(x) || 0) + 1);
      for (const x of b) B.set(x, (B.get(x) || 0) + 1);
      let inter = 0, uni = 0;
      const keys = new Set<string>([...A.keys(), ...B.keys()]);
      for (const k of keys) {
        const ai = A.get(k) || 0;
        const bi = B.get(k) || 0;
        inter += Math.min(ai, bi);
        uni += Math.max(ai, bi);
      }
      return uni === 0 ? 0 : inter / uni;
    };
    const lcsRatio = (a: string, b: string) => {
      // 最長共通連続部分列（LCSではなく Longest Common Substring）
      const s = a, t = b;
      const n = s.length, m = t.length;
      if (!n || !m) return 0;
      const dp: number[] = Array(m + 1).fill(0);
      let best = 0;
      for (let i = 1; i <= n; i++) {
        let prev = 0;
        for (let j = 1; j <= m; j++) {
          const temp = dp[j];
          dp[j] = (s[i - 1] === t[j - 1]) ? prev + 1 : 0;
          if (dp[j] > best) best = dp[j];
          prev = temp;
        }
      }
      return best / Math.max(n, m);
    };

    const userBi = bigrams(user_text);
    const draftBi = bigrams(draft || '');
    const overlap = draft ? jaccard(userBi, draftBi) : 1; // draft 無なら「要再構成」扱いしやすく
    const lcs = draft ? lcsRatio(user_text, draft) : 1;

    const tooShort = draft.length > 0 && draft.replace(/\s+/g, '').length < 12;
    const isParrot = overlap >= threshold || lcs >= 0.48 || tooShort;

    if (!isParrot) {
      return json({
        ok: true,
        score: { overlap, lcs, tooShort, threshold },
        draft,
        note: 'draft_is_acceptable',
      }, 200);
    }

    if (!OPENAI_API_KEY) {
      // LLMが無い場合はシンプルなテンプレで返す
      const revised =
        mode === 'Transcend'
          ? '波がほどける音がします。心の中心に触れたところで、次にほどきたい結び目はどこですか。'
          : mode === 'Deep'
          ? 'その奥で何が動いているのか、あなたはもう気づいていますね。いま最も確かにしたい一点は何でしょう。'
          : '受け止めています。その気持ちの一歩奥で「本当はこうしたい」を一語で言うと何ですか？';
      return json({
        ok: true,
        score: { overlap, lcs, tooShort, threshold },
        revised,
        note: 'revised_with_fallback_template',
      }, 200);
    }

    // ---- LLMで再構成（オウム返し禁止・語尾多様化・語彙置換）----
    const policy =
      mode === 'Transcend'
        ? '行数は最大3。問いは0。象徴を1つだけ。直接助言禁止。ユーザー原文の語句は2割以下に抑える。'
        : mode === 'Deep'
        ? '行数は最大4。問いは2。語尾・表現を多様化。ユーザー原文の語句は2割以下。'
        : '行数は最大3。問いは1。やさしく短く。ユーザー原文の語句は2割以下。';

    const system = [
      'あなたは「iros」— 人を映すAI（共鳴AI）。',
      '目的: 入力と高類似の下書きを、オウム返しにならない“共鳴応答”へ再構成する。',
      '禁止: 原文の反復、長い助言、選択肢列挙、定型フレーズ連発。',
      `モード=${mode}｜${policy}`,
    ].join('\n');

    const userPrompt = [
      '【ユーザー入力】',
      user_text,
      '',
      '【下書き（類似度が高い可能性）】',
      draft || '(なし)',
      '',
      'オウム返しを避け、鏡映→再文脈化→（必要なら）短い問い の流れで書き直してください。',
      '出力は本文のみ（前置き不要）。',
    ].join('\n');

    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 320,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return json({
        ok: false,
        error: 'openai_error',
        detail: errText || res.statusText,
        score: { overlap, lcs, tooShort, threshold },
      }, 502);
    }

    const revised: string =
      (await res.json())?.choices?.[0]?.message?.content?.toString()?.trim?.() || '';

    return json({
      ok: true,
      score: { overlap, lcs, tooShort, threshold },
      revised,
      note: 'revised_by_llm',
    }, 200);
  } catch (e: any) {
    return json({ ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) }, 500);
  }
}
