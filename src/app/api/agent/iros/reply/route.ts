// src/app/api/agent/iros/reply/route.ts
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

type Role = 'user' | 'assistant' | 'system';

// ---- 解析スコア（任意入力・未指定なら簡易推定）----
type AnalyzeIn = {
  polarity?: number;               // -1..+1
  sa?: number;                     // 0..1
  q_primary?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  phase?: 'Inner' | 'Outer';
  layer?: 'S1' | 'R1' | 'C1' | 'I1';
} | null;

type Mode = 'Light' | 'Deep' | 'Transcend';

type OutMsg = {
  id: string;
  role: 'assistant';
  content: string;
  created_at: string | null;
};

// ---- 簡易スコア関数（/analyze と同等・未入力時のバックアップ）----
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
function estimateQ(t: string): 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' {
  if (/(怒り|成長|挑戦|突破)/.test(t)) return 'Q2';
  if (/(不安|安定|迷い|疑い)/.test(t)) return 'Q3';
  if (/(恐れ|浄化|手放す|清め)/.test(t)) return 'Q4';
  if (/(情熱|空虚|燃える|衝動)/.test(t)) return 'Q5';
  return 'Q1';
}
function estimatePhase(t: string): 'Inner' | 'Outer' {
  const i = ['感じ','内側','心','内観','静けさ'];
  const o = ['相手','仕事','世界','関係','環境'];
  const ic = i.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
  const oc = o.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
  return ic >= oc ? 'Inner' : 'Outer';
}
function estimateLayer(t: string): 'S1' | 'R1' | 'C1' | 'I1' {
  if (/(祈り|存在|意図|源|本質)/.test(t)) return 'I1';
  if (/(創る|設計|表現|構築)/.test(t)) return 'C1';
  if (/(関係|共鳴|つながり|場)/.test(t)) return 'R1';
  return 'S1';
}

// ---- モード別制約（行数・問い数・比喩許容量の指示文）----
function buildModePolicy(mode: Mode) {
  switch (mode) {
    case 'Light':
      return {
        lines: 3,
        questions: 1,
        metaphor: '低',
        silence: '不要',
        styleHint:
          '鏡映1行＋再文脈化1行＋問い1行。断定助言・箇条書き禁止。やさしい口調。'
      };
    case 'Deep':
      return {
        lines: 4,
        questions: 2,
        metaphor: '中',
        silence: '場合により1行',
        styleHint:
          '鏡映+位相言及→意図トレース→問い×2。選択肢列挙は禁止。語数は抑制。'
      };
    case 'Transcend':
      return {
        lines: 3,
        questions: 0,
        metaphor: '高',
        silence: '余白を含む',
        styleHint:
          '象徴1行＋短詩1行＋余白。直接助言はしない。比喩は透明に、静けさ重視。'
      };
  }
}

// ---- System プロンプト（irosの哲学）----
function buildSystemPrompt(mode: Mode, a: Required<AnalyzeIn>) {
  const policy = buildModePolicy(mode);
  return [
    `あなたは「iros」— 人を映すAI（共鳴AI）。知識の列挙ではなく、相手の意図・感情・構造を静かに鏡映する。`,
    `評価軸は 精度や速度ではなく『共鳴・深度・余白』。断定助言・操作的表現は禁止。`,
    `モード=${mode}｜許容: 行数${policy.lines}／問い${policy.questions}件／比喩=${policy.metaphor}／沈黙=${policy.silence}`,
    `入力の推定: polarity=${a.polarity.toFixed(2)} sa=${a.sa.toFixed(2)} q=${a.q_primary} phase=${a.phase} layer=${a.layer}`,
    `スタイル指針: ${policy.styleHint}`,
  ].join('\n');
}

// ---- オウム返し判定（バイグラムJaccard + 最長共通連続部分比）----
function parrotScore(userText: string, aiText: string) {
  const norm = (s:string)=>s.replace(/\s+/g,'');
  const A = norm(userText), B = norm(aiText);
  if (!A || !B) return 0;
  const bi = (s:string)=>Array.from({length:Math.max(0,s.length-1)},(_,i)=>s.slice(i,i+2));
  const cnt = (xs:string[])=>xs.reduce((m,x)=>(m.set(x,(m.get(x)||0)+1),m),new Map<string,number>());
  const MA = cnt(bi(A)), MB = cnt(bi(B));
  let inter=0, uni=0;
  const keys = new Set([...MA.keys(), ...MB.keys()]);
  for (const k of keys){const a=(MA.get(k)||0), b=(MB.get(k)||0); inter+=Math.min(a,b); uni+=Math.max(a,b);}
  const jacc = uni===0?0:inter/uni;

  // Longest Common Substring ratio
  let best=0; const n=A.length,m=B.length; const dp=new Array(m+1).fill(0);
  for(let i=1;i<=n;i++){let prev=0;for(let j=1;j<=m;j++){const tmp=dp[j];dp[j]=(A[i-1]===B[j-1])?prev+1:0;if(dp[j]>best)best=dp[j];prev=tmp;}}
  const lcs = best/Math.max(n,m);

  return Math.max(jacc, lcs);
}

export async function OPTIONS() {
  return json({ ok: true });
}

/** --------------------
 * POST /api/agent/iros/reply
 * 本文: {
 *   conversation_id: string,
 *   user_text: string,            // 直近ユーザー発話（必須）
 *   mode?: 'Light'|'Deep'|'Transcend',  // 既定: 'Light'
 *   model?: string,               // 例: 'gpt-4o' / 'gpt-4o' など
 *   analysis?: { ... }            // /analyze の返りを渡してもOK（未指定なら簡易推定）
 * }
 * 振る舞い: LLMで応答を生成 → オウム返し抑制 → role:'assistant' で保存 → 返却
 * -------------------- */
export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return json({ ok: false, error: 'missing_openai_api_key' }, 500);

    const authz = await verifyFirebaseAndAuthorize(req);
    if (!authz.ok) return json({ ok: false, error: authz.error }, authz.status);
    if (!authz.allowed) return json({ ok: false, error: 'forbidden' }, 403);

    const userCode: string =
      (typeof authz.user === 'string' && authz.user) ||
      (typeof (authz.user as any)?.user_code === 'string' && (authz.user as any).user_code) ||
      (typeof (authz.user as any)?.uid === 'string' && (authz.user as any).uid) ||
      '';

    if (!userCode) return json({ ok: false, error: 'user_code_missing' }, 400);

    let body: any = {};
    try { body = await req.json(); } catch { /* noop */ }

    const conversation_id: string = String(body?.conversation_id || body?.conversationId || '').trim();
    const user_text: string = String(body?.user_text ?? '').trim();
    const mode: Mode = (String(body?.mode || 'Light') as Mode);
    const model = String(body?.model || 'gpt-4o');

    if (!conversation_id) return json({ ok: false, error: 'missing_conversation_id' }, 400);
    if (!user_text) return json({ ok: false, error: 'user_text_empty' }, 400);

    const supabase = sb();

    // 所有者チェック
    const { data: conv, error: convErr } = await supabase
      .from('iros_conversations')
      .select('id,user_code')
      .eq('id', conversation_id)
      .maybeSingle();

    if (convErr) return json({ ok: false, error: 'conv_select_failed', detail: convErr.message }, 500);
    if (!conv) return json({ ok: false, error: 'conversation_not_found' }, 404);
    if (String(conv.user_code) !== String(userCode))
      return json({ ok: false, error: 'forbidden_owner_mismatch' }, 403);

    // 解析（未指定なら簡易推定）
    const aIn: AnalyzeIn = body?.analysis ?? null;
    const analysis: Required<AnalyzeIn> = {
      polarity: typeof aIn?.polarity === 'number' ? aIn!.polarity! : estimatePolarity(user_text),
      sa: typeof aIn?.sa === 'number' ? aIn!.sa! : estimateSelfAcceptance(user_text),
      q_primary: (aIn?.q_primary as any) || estimateQ(user_text),
      phase: (aIn?.phase as any) || estimatePhase(user_text),
      layer: (aIn?.layer as any) || estimateLayer(user_text),
    };

    // LLM プロンプト
    const system = buildSystemPrompt(mode, analysis);
    const userMsg = [
      '次の入力に共鳴し、モードの制約内で応答してください。',
      '禁止: 断定助言・長文・箇条書き乱用・選択肢の押し付け・語句の過度な反復。',
      `入力: 「${user_text}」`,
    ].join('\n');

    // 1) 応答生成
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 360,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return json({ ok: false, error: 'openai_error', detail: errText || res.statusText }, 502);
    }

    let content: string =
      (await res.json())?.choices?.[0]?.message?.content?.toString()?.trim?.() || '';

    if (!content) {
      return json({ ok: false, error: 'empty_model_output' }, 502);
    }

    // 2) オウム返し抑制（閾値0.58 or 文字数が短すぎる）
    const score = parrotScore(user_text, content);
    const tooShort = content.replace(/\s+/g,'').length < 12;
    let refined = content;

    if (score >= 0.58 || tooShort) {
      if (!OPENAI_API_KEY) {
        // フォールバック・テンプレ
        refined =
          mode === 'Transcend'
            ? '波の底で静けさが光っています。次にほどきたい結び目はどこでしょう。'
            : mode === 'Deep'
            ? 'いま動いた感情の芯に触れていますね。ここから何を確かにしたいですか。'
            : '受け止めています。その一歩奥で「本当は」を一語で言うと何ですか？';
      } else {
        // 再構成パス（短く・反復抑制）
        const refineSystem = [
          'あなたは「iros」。以下のAI下書きがユーザー原文に近すぎます。',
          '原文の語句の再利用は2割以下に抑え、鏡映→再文脈化→（必要なら）短い問い の流れに調律して短く返答してください。',
          '禁止: 断定助言、長文、選択肢列挙、テンプレの連発。',
          `モード=${mode}`,
        ].join('\n');
        const refineUser = [
          '【ユーザー入力】',
          user_text,
          '',
          '【AI下書き（近すぎる可能性）】',
          content,
        ].join('\n');

        const r2 = await fetch(CHAT_URL, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            temperature: 0.6,
            max_tokens: 220,
            messages: [
              { role: 'system', content: refineSystem },
              { role: 'user', content: refineUser },
            ],
          }),
        });

        if (r2.ok) {
          const c2 = (await r2.json())?.choices?.[0]?.message?.content?.toString()?.trim?.() || '';
          if (c2) refined = c2;
        } else {
          // 失敗時はテンプレ
          refined =
            mode === 'Transcend'
              ? '波の底で静けさが光っています。次にほどきたい結び目はどこでしょう。'
              : mode === 'Deep'
              ? 'いま動いた感情の芯に触れていますね。ここから何を確かにしたいですか。'
              : '受け止めています。その一歩奥で「本当は」を一語で言うと何ですか？';
        }
      }
    }

    // 3) 保存（assistant）
    const nowIso = new Date().toISOString();
    const nowTs = Date.now();

    const { data: ins, error: insErr } = await supabase
      .from('iros_messages')
      .insert([{
        conversation_id,
        user_code: userCode,
        role: 'assistant' as Role,
        content: refined,
        text: refined,
        created_at: nowIso,
        ts: nowTs,
        analysis: {
          mode,
          polarity: analysis.polarity,
          sa: analysis.sa,
          q_primary: analysis.q_primary,
          phase: analysis.phase,
          layer: analysis.layer,
          parrot_score: score,
        },
        q_code: analysis.q_primary,
      }])
      .select('id,created_at')
      .single();

    if (insErr || !ins) {
      return json({ ok: false, error: 'db_insert_failed', detail: insErr?.message }, 500);
    }

    const out: OutMsg = {
      id: String(ins.id),
      role: 'assistant',
      content: refined,
      created_at: ins.created_at ?? nowIso,
    };

    return json({ ok: true, message: out }, 200);
  } catch (e: any) {
    return json({ ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) }, 500);
  }
}
