import { NextRequest, NextResponse } from 'next/server';
import { generateIrosReply } from '@/lib/iros/generate';
import { deriveFinalMode } from '@/lib/iros/intent';
import { IROS_PROMPT } from '@/lib/iros/system'; // buildSystemPrompt は使わない

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ===== 型定義 ===== */
type HistoryMsg = { role: 'user' | 'assistant' | 'system'; content: string };
type ReqBody = {
  conversationId?: string;
  user_text: string;
  mode?: string;
  history?: HistoryMsg[];
};

/* ===== Mode 定義（型安全） ===== */
const MODES = ['Light', 'Deep', 'Harmony', 'Transcend'] as const;
type Mode = (typeof MODES)[number];

function toMode(v: unknown): Mode {
  const s = typeof v === 'string' ? v.trim() : '';
  return (MODES as readonly string[]).includes(s as any) ? (s as Mode) : 'Light';
}

/* ===== Utility ===== */
function bad(message: string, code = 400) {
  return NextResponse.json({ ok: false, error: message }, { status: code });
}

/* ===== メイン処理 ===== */
export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) return bad('OPENAI_API_KEY is not set on server.', 500);

    const body = (await req.json()) as ReqBody;
    if (!body?.user_text?.trim()) return bad('`user_text` is required.');

    // --- モード決定 ---
    const requested = body.mode ?? 'Light';
    const seedMode = toMode(requested);
    const candidate = typeof deriveFinalMode === 'function'
      ? deriveFinalMode(seedMode, body.user_text)
      : seedMode;
    const mode = toMode(candidate);

    // --- system prompt を確定（固定）---
    const systemPrompt = IROS_PROMPT;

    // --- 履歴整形 ---
    const history: HistoryMsg[] = Array.isArray(body.history)
      ? body.history
          .filter(
            (m): m is HistoryMsg =>
              !!m && typeof m.content === 'string' && m.content.trim().length > 0,
          )
          .map((m) => ({ role: m.role, content: m.content.trim() }))
      : [];

    // --- Iros 応答生成 ---
    const assistant = await generateIrosReply({
      userText: body.user_text.trim(),
      history, // generate 側で直近3件に丸める
      model: process.env.IROS_MODEL || 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 600,
      apiKey,
    });

    return NextResponse.json({ ok: true, mode, systemPrompt, assistant });
  } catch (e: any) {
    console.error('[iros/reply] error', e);
    return bad(e?.message || 'Unexpected error', 500);
  }
}
