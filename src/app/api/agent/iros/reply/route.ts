// /src/app/api/agent/iros/reply/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { generateIrosReply } from '@/lib/iros/generate';
import { deriveFinalMode } from '@/lib/iros/intent';
import { analyzeFocus } from '@/lib/iros/focusCore'; // ← Qコード/位相・深度の観測用

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

    // --- 履歴整形（空文字や不正型を除去） ---
    const history: HistoryMsg[] = Array.isArray(body.history)
      ? body.history
          .filter(
            (m): m is HistoryMsg =>
              !!m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system') &&
              typeof m.content === 'string' && m.content.trim().length > 0,
          )
          .map((m) => ({ role: m.role, content: m.content.trim() }))
      : [];

    // --- Qコード/位相・深度の観測（出力には含めないが、デバッグに使う） ---
    const focus = analyzeFocus(body.user_text.trim());

    // --- Iros 応答生成（system prompt は generate 側でのみ構築する＝重複排除） ---
    const assistant = await generateIrosReply({
      userText: body.user_text.trim(),
      history,
      model: process.env.IROS_MODEL || 'gpt-4o-mini',
      temperature: 0.45,
      max_tokens: 640,
      apiKey,
    });

    // --- デバッグ出力（本番で出さない） ---
    const isDebug =
      process.env.NODE_ENV !== 'production' ||
      process.env.IROS_DEBUG === '1' ||
      req.headers.get('x-debug') === '1';

    if (isDebug) {
      // サーバーログに出す（本番では NODE_ENV=production 想定なので出ない）
      // 個人情報やAPIキーはログに含めない
      console.debug('[iros/reply][debug]', {
        mode,
        phase: focus.phase,
        depth: focus.depth,
        q: focus.q,
        qName: focus.qName,
        qConf: focus.qConf,
        domain: focus.domain,
        protectedFocus: focus.protectedFocus,
        anchors: focus.anchors,
        action: focus.action,
      });
    }

    // レスポンス：本番では軽量、デバッグ時のみ debug を含める
    const payload: any = { ok: true, mode, assistant };
    if (isDebug) {
      payload.debug = {
        phase: focus.phase,
        depth: focus.depth,
        q: focus.q,
        qName: focus.qName,
        qConf: focus.qConf,
        domain: focus.domain,
        protectedFocus: focus.protectedFocus,
        anchors: focus.anchors,
        action: focus.action,
      };
    }

    return NextResponse.json(payload);
  } catch (e: any) {
    console.error('[iros/reply] error', e);
    return bad(e?.message || 'Unexpected error', 500);
  }
}
