import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const fetchCache = 'default-no-store';

/**
 * Body:
 * {
 *   user_code: string,               // 必須
 *   event_type: 'kyomeikai' | 'ainori' | 'live' | string, // 必須（自由文字列OK）
 *   event_id?: string,               // 任意（ユニークIDや日付キーなどがあれば）
 *   note?: string                    // 任意（メモ）
 * }
 */
export async function POST(req: Request) {
  try {
    const b = await req.json().catch(() => ({}));
    const user_code = String(b.user_code || '').trim();
    const event_type = String(b.event_type || '').trim();
    const event_id = b.event_id ? String(b.event_id).trim() : null;
    const note = b.note ? String(b.note).trim() : null;

    // 必須チェック
    if (!user_code || !event_type) {
      return NextResponse.json(
        { ok: false, error: 'user_code and event_type are required' },
        { status: 400 },
      );
    }

    // --- Qコード（制約対応版） ---
    // ※ q_code_logs の CHECK 制約に合わせて currentQ / depthStage を必ず含める
    //   - currentQ: 'Q1'～'Q5' の何れか（イベント参加は “前進” とみなし Q1 をデフォルト）
    //   - depthStage: 'S1'～ などの任意ステージ。ここでは S1 を既定。
    const q_code = {
      q: 'Q1',
      by: 'sofia',
      hint: 'event-attend',
      meta: {
        source: 'event',
        kind: 'attend',
        event_type,
        ...(event_id ? { event_id } : {}),
        ...(note ? { note } : {}),
      },
      version: 'qmap.v0.3.2',
      currentQ: 'Q1',
      depthStage: 'S1',
      confidence: 0.6,
      color_hex: '#E6FFFA',
    };

    // --- 挿入（存在が確実なカラムのみ） ---
    const row = {
      user_code,
      source_type: 'event', // 文字列固定
      intent: 'event_attend', // 文字列固定
      q_code, // JSONB
    };

    const { error } = await supabaseAdmin.from('q_code_logs').insert([row]);
    if (error) {
      // 失敗理由を返す（開発中デバッグのため）
      return NextResponse.json(
        { ok: false, error: error.message || 'insert failed', detail: error },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, event_type, event_id, q_code });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'failed' }, { status: 500 });
  }
}
