// src/app/api/intention-prompts/create/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// CORS（curl検証を安定させる）
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * 受領ペイロード仕様
 * {
 *   title: string;                                   // 例: "2025-11-13-orion-T2"
 *   form: { ...IntentionForm... };                   // 祈り入力フォーム（オブジェクトのまま保存）
 *   finetune?: { ...FineTuneInput... } | null;       // 微調整（任意）
 *   prompt: string;                                   // 生成済みプロンプト本文
 *   shareUrl?: string | null;                         // buildShareUrl() で作成した共有URL（任意）
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // --- validate（外部ライブラリ不使用・最小限） ---
    const errors: string[] = [];
    const title = str(body.title, 'title', errors);
    const form = obj(body.form, 'form', errors);
    const finetune = body.finetune ?? null;
    const prompt = str(body.prompt, 'prompt', errors);
    const shareUrl = optStr(body.shareUrl, 'shareUrl', errors);

    // 派生メタ（一覧表示用）
    const author_name = typeof form?.name === 'string' ? form.name : null;
    const target_label = typeof form?.target === 'string' ? form.target : null;
    const t_layer = oneOf(form?.tLayer, ['T1', 'T2', 'T3', 'T4', 'T5'], 'form.tLayer', errors);
    const mood = oneOf(form?.mood, ['静けさ','希望','情熱','不安','迷い','感謝'], 'form.mood', []).value ?? null;
    const visibility = oneOf(form?.visibility, ['公開','非公開'], 'form.visibility', errors);

    const lat = numOrNull(form?.lat);
    const lon = numOrNull(form?.lon);
    const season = oneOf(form?.season, ['未指定','夏','秋','冬','春'], 'form.season', []).value ?? null;
    const timing = oneOf(form?.timing, ['設けない','早急','近未来','将来','使命'], 'form.timing', []).value ?? null;

    if (errors.length > 0) {
      return NextResponse.json({ ok: false, errors }, { status: 400, headers: CORS_HEADERS });
    }

    // --- insert ---
    const { data, error } = await supabaseAdmin
      .from('intention_prompts')
      .insert({
        title,
        author_name,
        target_label,
        t_layer: t_layer.value,
        mood,
        visibility: visibility.value,
        lat,
        lon,
        season,
        timing,
        form_payload: form,
        finetune_payload: finetune,
        prompt_text: prompt,
        share_url: shareUrl ?? null,
      })
      .select('id, created_at')
      .single();

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500, headers: CORS_HEADERS },
      );
    }

    return NextResponse.json(
      { ok: true, id: data.id, created_at: data.created_at },
      { status: 200, headers: { ...CORS_HEADERS, 'x-handler': 'app/api/intention-prompts/create' } },
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}

/* ====== ローカル検証ユーティリティ ====== */
function str(v: unknown, name: string, errors: string[]) {
  if (typeof v !== 'string' || v.trim() === '') {
    errors.push(`${name}: string is required`);
    return '';
  }
  return v;
}
function optStr(v: unknown, _name: string, _errors: string[]) {
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}
function obj(v: unknown, name: string, errors: string[]) {
  if (typeof v !== 'object' || v == null || Array.isArray(v)) {
    errors.push(`${name}: object is required`);
    return null;
  }
  return v as Record<string, unknown>;
}
function oneOf<T extends string>(
  v: any,
  list: readonly T[],
  name: string,
  errors: string[]
): { value: T | null } {
  if (typeof v !== 'string') {
    errors.push(`${name}: must be one of [${list.join(', ')}]`);
    return { value: null };
  }
  const hit = list.includes(v as T) ? (v as T) : null;
  if (!hit) errors.push(`${name}: must be one of [${list.join(', ')}]`);
  return { value: hit };
}
function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}
