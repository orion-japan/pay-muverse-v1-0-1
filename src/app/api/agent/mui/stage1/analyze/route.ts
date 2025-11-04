export const runtime = 'nodejs';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/* ===== Utility ===== */
function must(n: string) {
  const v = process.env[n];
  if (!v) throw new Error(`Missing ${n}`);
  return v;
}
function clamp(s: string, max = 6000) {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max);
}

/* ===== Supabase ===== */
const supa = createClient(must('NEXT_PUBLIC_SUPABASE_URL'), must('SUPABASE_SERVICE_ROLE_KEY'));

/* ===== API本体 ===== */
export async function POST(req: Request) {
  try {
    const { conv_code, user_code } = await req.json().catch(() => ({}) as any);
    if (!conv_code)
      return NextResponse.json({ ok: false, error: 'conv_code is required' }, { status: 400 });

    /* ---- 会話ログ取得 ---- */
    const { data: logs } = await supa
      .from('mui_chat_logs')
      .select('content')
      .eq('conversation_code', conv_code)
      .order('created_at', { ascending: false })
      .limit(40);

    const joined = (logs?.map((l: any) => l.content).join('\n\n') || '').trim();
    if (!joined)
      return NextResponse.json(
        { ok: false, error: '会話ログが見つかりません（mui_chat_logs）。' },
        { status: 200 },
      );

    /* ---- OpenAI呼び出し ---- */
    const OPENAI_API_KEY = must('OPENAI_API_KEY');
    const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
    const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

    const messages = [
      {
        role: 'system',
        content: 'あなたは恋愛コミュニケーション解析AI「Mui」。JSONのみ返す。',
      },
      {
        role: 'user',
        content: [
          '以下の会話ログを解析し、指定のJSON構造で返してください。',
          `{
            "q_code": "Q1|Q2|Q3|Q4|Q5",
            "summary": "",
            "bullets": [],
            "advice": [],
            "next_actions": [],
            "ls7": { "top": "DEPENDENT|AVOIDER|CARETAKER|IDEALIST|CONTROLLER|FREE_SPIRIT|CHASER", "hits": [] }
          }`,
          '--- 会話ログ ---',
          clamp(joined, 6000),
        ].join('\n'),
      },
    ];

    const r = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.4,
      }),
    });

    if (!r.ok) throw new Error(`OpenAI API error (${r.status}): ${await r.text()}`);

    const ai = await r.json();
    const content = ai?.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAIから内容が返りませんでした。');
    const parsed = JSON.parse(content);

    /* ---- 結果整形 ---- */
    const result = {
      q_code: parsed.q_code || 'Q3',
      summary: parsed.summary || '',
      bullets: parsed.bullets || [],
      advice: parsed.advice || [],
      next_actions: parsed.next_actions || [],
      ls7: parsed.ls7 || null,
    };

    /* ---- Supabaseに保存（upsert） ---- */
    const { error: upErr } = await supa.from('mui_phase1_results').upsert(
      {
        conv_code,
        user_code: user_code || null,
        q_code: result.q_code,
        result_json: result,
      },
      { onConflict: 'conv_code' },
    );

    if (upErr) throw new Error(`Supabase保存エラー: ${upErr.message || upErr}`);

    return NextResponse.json({ ok: true, stage: '1', result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
