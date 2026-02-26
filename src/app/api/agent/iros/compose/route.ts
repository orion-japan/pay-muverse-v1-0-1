// src/app/api/agent/iros/compose/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const sb = () => createClient(SUPABASE_URL!, SERVICE_ROLE!);

const CORS_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-code, x-trace-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (data: any, status = 200) =>
  new NextResponse(JSON.stringify(data), { status, headers: CORS_HEADERS });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

type Role = 'user' | 'assistant';
type Mode = 'Light' | 'Deep' | 'Transcend';

type AnalyzeOut = {
  polarity: number; // -1..+1
  sa: number; // 0..1
  q_primary: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  phase: 'Inner' | 'Outer';
  layer: 'S1' | 'R1' | 'C1' | 'I1' | 'T1';
};

// ---- 簡易スコア関数（/analyze と同一ロジック）----
const NEG = ['つらい', '不安', '怖い', '無理', '嫌', '怒り', '疲れ', 'しんどい', '泣'];
const POS = ['嬉しい', '安心', '好き', '大丈夫', '楽しい', '幸せ', '助かる', 'ありがとう'];
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function estimatePolarity(t: string): number {
  const p = POS.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
  const n = NEG.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
  if (p === 0 && n === 0) return 0;
  return (p - n) / (p + n);
}

function estimateSelfAcceptance(t: string): number {
  const self = ['私', 'わたし', '自分', '僕', 'わたくし'];
  const accept = ['大丈夫', '受け入れる', '許す', '落ち着く', '呼吸'];
  const deny = ['無理', 'ダメ', 'できない', '嫌い', '否定'];
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
  const i = ['感じ', '内面', '心', '内観', '静けさ'];
  const o = ['相手', '仕事', '世界', '関係', '環境'];
  const ic = i.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
  const oc = o.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
  return ic >= oc ? 'Inner' : 'Outer';
}

function estimateLayer(t: string): AnalyzeOut['layer'] {
  // ★ T層：宇宙意図・フィールド・根源系のワード
  if (/(宇宙|宇宙意志|宇宙の意図|ビッグバン|意図フィールド|T層|根源|源泉|普遍|全体意識)/.test(t)) {
    return 'T1';
  }
  if (/(祈り|存在|意図|源|本質)/.test(t)) return 'I1';
  if (/(創る|設計|表現|構築)/.test(t)) return 'C1';
  if (/(関係|共鳴|つながり|場)/.test(t)) return 'R1';
  return 'S1';
}

// ---- モード別制約（/reply と同等）----
function buildModePolicy(mode: Mode) {
  switch (mode) {
    case 'Light':
      return {
        lines: 3,
        questions: 1,
        metaphor: '低',
        silence: '不要',
        styleHint: '鏡映1行＋再文脈化1行＋問い1行。断定助言・箇条書き禁止。やさしい口調。',
      };
    case 'Deep':
      return {
        lines: 4,
        questions: 2,
        metaphor: '中',
        silence: '場合により1行',
        styleHint: '鏡映+位相言及→意図トレース→問い×2。選択肢列挙は禁止。語数は抑制。',
      };
    case 'Transcend':
      return {
        lines: 3,
        questions: 0,
        metaphor: '高',
        silence: '余白を含む',
        styleHint: '象徴1行＋短詩1行＋余白。直接助言はしない。比喩は透明に、静けさ重視。',
      };
  }
}

function buildSystemPrompt(mode: Mode, a: AnalyzeOut) {
  const p = buildModePolicy(mode);
  return [
    `あなたは「iros」— 人を映すAI（共鳴AI）。知識の列挙ではなく、相手の意図・感情・構造を静かに鏡映する。`,
    `評価軸は『共鳴・深度・余白』。断定助言・操作的表現は禁止。`,
    `モード=${mode}｜許容: 行数${p.lines}／問い${p.questions}件／比喩=${p.metaphor}／沈黙=${p.silence}`,
    `入力の推定: polarity=${a.polarity.toFixed(2)} sa=${a.sa.toFixed(2)} q=${a.q_primary} phase=${a.phase} layer=${a.layer}`,
    `スタイル指針: ${p.styleHint}`,
  ].join('\n');
}

export async function OPTIONS() {
  return json({ ok: true });
}

function pickTraceId(body: any): string | null {
  const a = String(body?.traceId ?? '').trim();
  if (a) return a;

  const b = String(body?.meta?.extra?.traceId ?? body?.meta?.extra?.trace_id ?? '').trim();
  if (b) return b;

  return null;
}

function mergeMetaWithTraceId(metaIn: any, traceId: string | null) {
  const base = metaIn && typeof metaIn === 'object' ? metaIn : {};
  const ex = base.extra && typeof base.extra === 'object' ? base.extra : {};
  const extra = traceId ? { ...ex, traceId } : ex;
  return { ...base, extra };
}

/** --------------------
 * POST /api/agent/iros/compose
 * 本文: {
 *   conversation_id: string,
 *   user_text: string,
 *   mode?: 'Light'|'Deep'|'Transcend',
 *   model?: string,
 *   traceId?: string,
 *   meta?: any
 * }
 * -------------------- */
export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return json({ ok: false, error: 'missing_openai_api_key' }, 500);

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      /* noop */
    }

    // --- dev bypass (reply と同等の思想) ---
    const DEV_BYPASS = process.env.IROS_DEV_BYPASS_AUTH === '1' && process.env.NODE_ENV !== 'production';
    const hUserCode = String(req.headers.get('x-user-code') ?? '').trim();

    let userCode = '';
    if (DEV_BYPASS && hUserCode) {
      userCode = hUserCode;
    } else {
      const authz = await verifyFirebaseAndAuthorize(req);
      if (!authz.ok) return json({ ok: false, error: authz.error }, authz.status || 401);
      if (!authz.allowed) return json({ ok: false, error: 'forbidden' }, 403);

      userCode =
        (typeof authz.user === 'string' && authz.user) ||
        (typeof (authz.user as any)?.user_code === 'string' && (authz.user as any).user_code) ||
        (authz as any)?.userCode ||
        (authz as any)?.jwt?.sub ||
        '';
    }

    if (!userCode) return json({ ok: false, error: 'user_code_missing' }, 400);

    const conversation_id: string = String(body?.conversation_id || body?.conversationId || '').trim();
    const user_text: string = String(body?.user_text ?? body?.userText ?? '').trim();
    const mode: Mode = (String(body?.mode || 'Light') as Mode);
    const model = String(body?.model || 'gpt-5');

    if (!conversation_id) return json({ ok: false, error: 'missing_conversation_id' }, 400);
    if (!user_text) return json({ ok: false, error: 'user_text_empty' }, 400);

    const traceId = pickTraceId(body);
    const metaUser = mergeMetaWithTraceId(body?.meta ?? null, traceId);

    const supabase = sb();

    // 所有者チェック
    const { data: conv, error: convErr } = await supabase
      .from('iros_conversations')
      .select('id,user_code')
      .eq('id', conversation_id)
      .maybeSingle();

    if (convErr) return json({ ok: false, error: 'conv_select_failed', detail: convErr.message }, 500);
    if (!conv) return json({ ok: false, error: 'conversation_not_found' }, 404);
    if (String(conv.user_code) !== String(userCode)) return json({ ok: false, error: 'forbidden_owner_mismatch' }, 403);

    // (1) userメッセージ保存（trace_id / meta.extra.traceId を確実に）
    const nowIso = new Date().toISOString();
    const nowTs = Date.now();

    const { data: insUser, error: insUserErr } = await supabase
      .from('iros_messages')
      .insert([
        {
          conversation_id,
          user_code: userCode,
          role: 'user' as Role,
          content: user_text,
          text: user_text,
          created_at: nowIso,
          ts: nowTs,
          trace_id: traceId,
          meta: metaUser,
        },
      ])
      .select('id,created_at')
      .single();

    if (insUserErr || !insUser) {
      return json({ ok: false, error: 'db_insert_user_failed', detail: insUserErr?.message }, 500);
    }

    // (2) 解析（保存しない）
    const analysis: AnalyzeOut = {
      polarity: estimatePolarity(user_text),
      sa: estimateSelfAcceptance(user_text),
      q_primary: estimateQ(user_text),
      phase: estimatePhase(user_text),
      layer: estimateLayer(user_text),
    };
    // ✅ OpenAIレスポンスから本文を拾う（compose内ローカル・依存なし）
    const pickTextSafe = (d: any): string => {
      try {
        const c0 = d?.choices?.[0] ?? null;

        // 1) 標準: message.content が string
        const msg = c0?.message ?? null;
        if (typeof msg?.content === 'string') return msg.content.trim();

        // 2) message.content が配列（content parts）っぽい場合
        if (Array.isArray(msg?.content)) {
          const s = msg.content
            .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
            .join('');
          return String(s).trim();
        }

        // 3) 旧: choices[0].text
        if (typeof c0?.text === 'string') return c0.text.trim();

        // 4) Responses系互換: output_text
        if (typeof d?.output_text === 'string') return d.output_text.trim();

        return '';
      } catch {
        return '';
      }
    };
    // (3) LLMで応答生成
    const system = buildSystemPrompt(mode, analysis);
    const userMsg = [
      '次の入力に共鳴し、モードの制約内で応答してください。',
      '禁止: 断定助言・長文・箇条書き乱用・選択肢の押し付け。',
      `入力: 「${user_text}」`,
    ].join('\n');

    // --- OpenAI request payload（診断付き） ---
    const payload = {
      model,
      // messages は既存のものをそのまま使うこと（この下のコードはあなたの実装に合わせて）
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],

      // ✅ gpt-5 仕様：max_completion_tokens を明示
      max_completion_tokens: 360,

      // ✅ temperature は送らない（gpt-5 で 0.7 等が落ちる）
      // temperature: undefined,
    };

    console.log('[IROS/COMPOSE][OPENAI_REQ_DIAG]', {
      model,
      max_completion_tokens: (payload as any)?.max_completion_tokens ?? null,
      hasTemperature: Object.prototype.hasOwnProperty.call(payload as any, 'temperature'),
      messagesLen: Array.isArray((payload as any)?.messages) ? (payload as any).messages.length : null,
      userTextLen: user_text.length,
      traceId,
    });

    // --- (A) 1st call ---
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const raw1 = await res.text().catch(() => '');
    if (!res.ok) {
      return json({ ok: false, error: 'openai_error', detail: raw1 || res.statusText }, 502);
    }

    let data: any = null;
    try {
      data = JSON.parse(raw1);
    } catch {
      return json(
        {
          ok: false,
          error: 'openai_bad_json',
          detail: { status: res.status, head200: raw1.slice(0, 200) },
        },
        502,
      );
    }

    // ✅ usage / choice を必ずログに残す（空返答のときに証拠になる）
    try {
      console.log('[IROS/COMPOSE][OPENAI_RESP_META]', {
        model: data?.model ?? null,
        usage: data?.usage ?? null,
        finish_reason: data?.choices?.[0]?.finish_reason ?? null,
        contentType: typeof data?.choices?.[0]?.message?.content,
        contentLen: typeof data?.choices?.[0]?.message?.content === 'string'
          ? data.choices[0].message.content.length
          : null,
      });
    } catch {
      /* noop */
    }

    // --- (B) 空なら 1回だけフォールバック再試行（ユーザーのみ + tokens増） ---
    let assistantText: string = pickTextSafe(data);

    if (!assistantText) {
      const payload2 = {
        model,
        messages: [{ role: 'user', content: userMsg }],
        max_completion_tokens: 800,
      };

      console.log('[IROS/COMPOSE][OPENAI_RETRY]', {
        model,
        max_completion_tokens: (payload2 as any).max_completion_tokens,
        reason: 'empty_model_output_first',
        traceId,
      });

      const res2 = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload2),
      });

      const raw2 = await res2.text().catch(() => '');
      if (!res2.ok) {
        return json(
          { ok: false, error: 'openai_error_retry', detail: raw2 || res2.statusText },
          502,
        );
      }

      let data2: any = null;
      try {
        data2 = JSON.parse(raw2);
      } catch {
        return json(
          {
            ok: false,
            error: 'openai_bad_json_retry',
            detail: { status: res2.status, head200: raw2.slice(0, 200) },
          },
          502,
        );
      }

      try {
        console.log('[IROS/COMPOSE][OPENAI_RESP_META_RETRY]', {
          model: data2?.model ?? null,
          usage: data2?.usage ?? null,
          finish_reason: data2?.choices?.[0]?.finish_reason ?? null,
          contentType: typeof data2?.choices?.[0]?.message?.content,
          contentLen: typeof data2?.choices?.[0]?.message?.content === 'string'
            ? data2.choices[0].message.content.length
            : null,
        });
      } catch {
        /* noop */
      }

      assistantText = pickTextSafe(data2);
      if (!assistantText) {
        // ここまで来たら “OpenAIが空を返した” が確定なので、生レスポンスの head も返す
        return json(
          {
            ok: false,
            error: 'empty_model_output',
            detail: {
              first: {
                finish_reason: data?.choices?.[0]?.finish_reason ?? null,
                usage: data?.usage ?? null,
                rawHead200: raw1.slice(0, 200),
              },
              retry: {
                finish_reason: data2?.choices?.[0]?.finish_reason ?? null,
                usage: data2?.usage ?? null,
                rawHead200: raw2.slice(0, 200),
              },
            },
          },
          502,
        );
      }

      // ✅ retry の本文が取れたら data を差し替えて、下流（保存など）を通常進行させる
      data = data2;
    }

    // (3b) assistant保存（trace_id / meta.extra.traceId を確実に）
    const nowIso2 = new Date().toISOString();
    const nowTs2 = Date.now();

    const metaAsst = mergeMetaWithTraceId(
      {
        analysis: {
          mode,
          polarity: analysis.polarity,
          sa: analysis.sa,
          q_primary: analysis.q_primary,
          phase: analysis.phase,
          layer: analysis.layer,
        },
      },
      traceId,
    );

    const { data: insAsst, error: insAsstErr } = await supabase
      .from('iros_messages')
      .insert([
        {
          conversation_id,
          user_code: userCode,
          role: 'assistant' as Role,
          content: assistantText,
          text: assistantText,
          created_at: nowIso2,
          ts: nowTs2,
          q_code: analysis.q_primary,
          trace_id: traceId,
          meta: metaAsst,
        },
      ])
      .select('id,created_at')
      .single();

    if (insAsstErr || !insAsst) {
      return json({ ok: false, error: 'db_insert_assistant_failed', detail: insAsstErr?.message }, 500);
    }

    return json(
      {
        ok: true,
        traceId,
        user_message: {
          id: String(insUser.id),
          role: 'user' as Role,
          content: user_text,
          created_at: insUser.created_at ?? nowIso,
        },
        assistant_message: {
          id: String(insAsst.id),
          role: 'assistant' as Role,
          content: assistantText,
          created_at: insAsst.created_at ?? nowIso2,
        },
        analysis,
      },
      200,
    );
  } catch (e: any) {
    return json({ ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) }, 500);
  }
}
