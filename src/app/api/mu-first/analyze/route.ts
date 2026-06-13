export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';

import { verifyFirebaseAndAuthorize, normalizeAuthz } from '@/lib/authz';
import { analyzeScreenshot } from '@/lib/mu-first/analyzeScreenshot';
import type { VisionModelKey } from '@/lib/mu-first/types';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getUserJourneySummary, recordUserJourneyEvent } from '@/lib/userJourney';

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

function getDefaultModel(): VisionModelKey {
  const raw = process.env.MU_FIRST_DEFAULT_MODEL || 'gemini-2.5-flash';
  const allowed: VisionModelKey[] = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'claude-haiku',
    'claude-sonnet',
    'gpt-4.1-mini',
  ];
  return allowed.includes(raw as VisionModelKey) ? (raw as VisionModelKey) : 'gemini-2.5-flash';
}

async function requireUser(req: NextRequest) {
  const authz = await verifyFirebaseAndAuthorize(req);
  const { user, error } = normalizeAuthz(authz);
  return { user, error };
}

async function getScreenshotCreditCount(userCode: string) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('screenshot_credit_count')
    .eq('user_code', userCode)
    .maybeSingle();

  if (error) throw error;
  return Number((data as any)?.screenshot_credit_count ?? 0);
}

async function consumeScreenshotCredit(userCode: string) {
  const rpc = await supabaseAdmin.rpc('consume_screenshot_credit', {
    p_user_code: userCode,
  });

  if (!rpc.error) return rpc.data === true;

  // Migration未適用時の暫定フォールバック。最終的にはRPCを正本にする。
  console.warn('[mu-first] consume_screenshot_credit RPC failed; fallback update', rpc.error.message);
  const current = await getScreenshotCreditCount(userCode);
  if (current <= 0) return false;

  const { error } = await supabaseAdmin
    .from('users')
    .update({ screenshot_credit_count: current - 1 })
    .eq('user_code', userCode);

  if (error) throw error;
  return true;
}

export async function GET(req: NextRequest) {
  const { user, error } = await requireUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: error ?? 'Unauthorized' }, { status: 401 });
  }

  const summary = await getUserJourneySummary(user.user_code);
  return NextResponse.json({
    ok: true,
    screenshotCreditCount: summary.screenshot_credit_count,
    firstScreenshotCompleted: summary.first_screenshot_completed,
    firstScreenshotUsedAt: summary.first_screenshot_used_at,
  });
}

export async function POST(req: NextRequest) {
  const { user, error } = await requireUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: error ?? 'Unauthorized' }, { status: 401 });
  }

  const userCode = user.user_code;

  try {
    const form = await req.formData();
    const image = form.get('image');
    const mediaCode = String(form.get('media_code') ?? form.get('mediaCode') ?? '').trim() || null;

    if (!(image instanceof File)) {
      return NextResponse.json({ ok: false, error: '画像ファイルがありません。' }, { status: 400 });
    }

    if (!ALLOWED_MIME_TYPES.has(image.type)) {
      return NextResponse.json(
        { ok: false, error: '画像はPNG、JPEG、WebPのみ対応しています。' },
        { status: 400 },
      );
    }

    if (image.size > MAX_IMAGE_SIZE_BYTES) {
      return NextResponse.json(
        { ok: false, error: '画像サイズは5MB以内にしてください。' },
        { status: 400 },
      );
    }

    const beforeCredit = await getScreenshotCreditCount(userCode);
    if (beforeCredit <= 0) {
      return NextResponse.json(
        { ok: false, error: 'スクショ診断クレジットがありません。' },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await image.arrayBuffer());
    const imageBase64 = buffer.toString('base64');
    const model = getDefaultModel();

    await recordUserJourneyEvent({
      userCode,
      eventName: 'first_screenshot_started',
      source: 'mu_first',
      pagePath: '/mu-first',
      campaign: mediaCode,
      metadata: { mimeType: image.type, size: image.size, model },
    });

    const result = await analyzeScreenshot({
      model,
      imageBase64,
      mimeType: image.type,
    });

    const consumed = await consumeScreenshotCredit(userCode);
    if (!consumed) {
      return NextResponse.json(
        { ok: false, error: 'スクショ診断クレジットがありません。' },
        { status: 400 },
      );
    }

    const afterCredit = await getScreenshotCreditCount(userCode).catch(() => Math.max(beforeCredit - 1, 0));

    await supabaseAdmin.from('mu_screenshot_diagnosis_logs').insert({
      user_code: userCode,
      model,
      source: 'mu_first',
      media_code: mediaCode,
      credit_used: 1,
    });

    await recordUserJourneyEvent({
      userCode,
      eventName: 'first_screenshot_diagnosed',
      source: 'mu_first',
      pagePath: '/mu-first',
      campaign: mediaCode,
      metadata: { model, screenshotCreditRemaining: afterCredit },
    });

    return NextResponse.json({
      ok: true,
      result: result.text,
      model: result.model,
      screenshotCreditRemaining: afterCredit,
    });
  } catch (e: any) {
    console.error('[mu-first/analyze] failed', e);
    return NextResponse.json(
      { ok: false, error: e?.message || '診断に失敗しました。' },
      { status: 500 },
    );
  }
}
