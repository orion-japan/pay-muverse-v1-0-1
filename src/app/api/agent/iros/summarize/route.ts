// src/app/api/agent/iros/summarize/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

import {
  containsBannedAbstractIntro,
  inferGoal,
  detectIsDark,
  type Mode,
} from '@/lib/iros/intent';
import { chatComplete } from '@/lib/iros/openai';

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
const MODEL_DEFAULT = 'gpt-4o';

type Role = 'user' | 'assistant' | 'system';

export async function OPTIONS() {
  return json({ ok: true });
}

/* =========================
 * Utils
 * ========================= */

function toNonEmptyTrimmedString(v: any): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length ? s : null;
}

async function trySelect<T>(
  supabase: ReturnType<typeof sb>,
  tables: readonly string[],
  columnsByTable: Record<string, string>,
  modify: (q: any, table: string) => any,
) {
  for (const table of tables) {
    const columns = columnsByTable[table] ?? columnsByTable['*'] ?? '*';
    try {
      const { data, error } = await modify(
        (supabase as any).from(table).select(columns),
        table,
      );
      if (!error) return { ok: true as const, data, table };
    } catch {
      // ignore and try next
    }
  }
  return { ok: false as const, error: 'select_failed_all_candidates' as const };
}

/**
 * POST /api/agent/iros/summarize
 * body: { conversation_id: string, model?: string, mode?: Mode }
 * 振る舞い:
 * - 会話ログ（直近N件）を集め
 * - iros調で 1) 共鳴要約(3行以内) 2) 意図(1行) 3) 次の一歩(10分以内・1つ) を返す
 *
 * ✅ 重要:
 * - ts が NULL 混在するため、並び順は created_at を正にする
 * - user_code で必ず絞る（混線防止）
 * - view / ui / normalized を優先して拾う（text確定を優先）
 */
export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return json({ ok: false, error: 'missing_openai_api_key' }, 500);

    const authz = await verifyFirebaseAndAuthorize(req);
    if (!authz.ok) return json({ ok: false, error: authz.error }, authz.status);
    if (!authz.allowed) return json({ ok: false, error: 'forbidden' }, 403);

    const userCode: string =
      (typeof (authz.user as any)?.user_code === 'string' && (authz.user as any).user_code) ||
      (typeof (authz.user as any)?.uid === 'string' && (authz.user as any).uid) ||
      '';
    if (!userCode) return json({ ok: false, error: 'user_code_missing' }, 400);

    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const conversation_id: string = String(body?.conversation_id || body?.conversationId || '').trim();
    const model = String(body?.model || MODEL_DEFAULT);
    const reqMode: Mode = String(body?.mode || 'Light') as Mode;

    if (!conversation_id) return json({ ok: false, error: 'missing_conversation_id' }, 400);

    // 所有者チェック
    const supabase = sb();
    const { data: conv, error: convErr } = await (supabase as any)
      .from('iros_conversations')
      .select('id,user_code')
      .eq('id', conversation_id)
      .maybeSingle();

    if (convErr)
      return json({ ok: false, error: 'conv_select_failed', detail: convErr.message }, 500);
    if (!conv) return json({ ok: false, error: 'conversation_not_found' }, 404);
    if (String(conv.user_code) !== String(userCode))
      return json({ ok: false, error: 'forbidden_owner_mismatch' }, 403);

    // ✅ 直近メッセージ取得（view優先 / created_at順 / user_codeで絞る）
    const MSG_TABLES = [
      'v_iros_messages',
      'iros_messages_ui',
      'iros_messages_normalized',
      'iros_messages',
      'public.iros_messages',
    ] as const;

    const columnsByTable: Record<string, string> = {
      // view: text が正
      v_iros_messages: ['role', 'text', 'created_at', 'user_code'].join(','),
      // ui: text が正
      iros_messages_ui: ['role', 'text', 'created_at', 'user_code'].join(','),
      // normalized: content が正
      iros_messages_normalized: ['role', 'content', 'created_at', 'user_code'].join(','),
      // table: text/content 両方あり得る
      iros_messages: ['role', 'content', 'text', 'created_at', 'user_code'].join(','),
      'public.iros_messages': ['role', 'content', 'text', 'created_at', 'user_code'].join(','),
      '*': ['role', 'content', 'text', 'created_at', 'user_code'].join(','),
    };

// ✅ summarize は “本文の正” を iros_messages に固定（view混線を避ける）
const LIMIT = 60;

const { data: msgs, error: msgErr } = await supabase
  .from('iros_messages') // ✅ 固定
  .select('role,content,text,created_at')
  .eq('conversation_id', conversation_id)
  .eq('user_code', userCode)
  .in('role', ['user', 'assistant'])
  // ✅ 直近N件を確実に取る：DESC → reverse で古→新
  .order('created_at', { ascending: false })
  .limit(LIMIT);

if (msgErr) {
  return json({ ok: false, error: 'msg_select_failed', detail: msgErr.message }, 500);
}

const rows: any[] = Array.isArray(msgs) ? msgs : [];
rows.reverse();

// transcript を作る（text優先 → content）
const transcript = rows
  .map((m) => {
    const roleRaw = String(m?.role ?? '').toLowerCase() === 'assistant' ? 'assistant' : 'user';
    const textVal =
      toNonEmptyTrimmedString(m?.text) ??
      toNonEmptyTrimmedString(m?.content) ??
      '';
    const safe = String(textVal).replace(/\r\n/g, '\n');
    return `${roleRaw === 'user' ? 'U' : 'A'}: ${safe}`;
  })
  .join('\n');

    const isDark = detectIsDark(transcript);
    const goal = inferGoal(transcript);
    const banned = containsBannedAbstractIntro(transcript)
      ? '（抽象語が多いので、ユーザー語彙へ再文脈化）'
      : '';

    const system = [
      'あなたは「iros」— 人を映す共鳴AI。',
      '会話全体を 1) 共鳴要約（3行以内） 2) 見えてきた意図（1行） 3) 次の一歩（10分以内・1つ）で返す。',
      '新規抽象トピックは導入しない。語彙は会話内の文脈で再構成する。',
      `モード=${reqMode} ${isDark ? '（ダーク調の余白を保つ）' : ''} ${banned}`,
      goal ? `推定ゴール=${goal}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const userPrompt = [
      '【会話ログ（古→新）】',
      transcript || '(空)',
      '',
      '上記を踏まえ、以下の形式で短く出力：',
      '——',
      '共鳴要約：',
      '意図：',
      '次の一歩：',
      '——',
    ].join('\n');

    const content = await chatComplete({
      apiKey: OPENAI_API_KEY,
      model,
      temperature: 0.5,
      max_tokens: 360,
      messages: [
        { role: 'system' as Role, content: system },
        { role: 'user' as Role, content: userPrompt },
      ],
    });

    if (!content) return json({ ok: false, error: 'empty_model_output' }, 502);

    return json(
      {
        ok: true,
        summary: content,
        source: 'iros_messages', // ✅ res はもう無いので固定
        count: rows.length,
      },
      200,
    );

  } catch (e: any) {
    return json(
      { ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) },
      500,
    );
  }
}
