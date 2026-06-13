import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * POST /api/register/apply-initial-credit
 * Body: { user_code: string, eve?: string }
 *
 * - 通常は 90 クレジットを付与
 * - eve が指定され、invite_codes に一致すれば、その bonus_credit で上書き
 * - credit_ledger に entry_key='initial_signup' として upsert
 */
export async function POST(req: NextRequest) {
  try {
    const { user_code, eve } = await req.json();

    if (!user_code) {
      return NextResponse.json({ ok: false, error: 'missing user_code' }, { status: 400 });
    }

    // デフォルト値
    let creditToApply = 90;
    let appliedBy = 'default';

    // eve があれば招待情報を確認
    if (eve) {
      const { data: invite, error } = await supabaseAdmin
        .from('invite_codes')
        .select('campaign_type, bonus_credit, code')
        .eq('code', eve)
        .maybeSingle();

      if (error) throw error;

      if (invite && invite.campaign_type === 'bonus-credit') {
        const v = Number(invite.bonus_credit ?? 90);
        if (!Number.isNaN(v) && v >= 0) {
          creditToApply = v; // ← 上書き
          appliedBy = `eve:${invite.code}`;
        }
      }
    }

    // ledger に upsert（user_code + entry_key = unique）
    const row = {
      user_code,
      entry_key: 'initial_signup', // ← これで「1ユーザー1レコード」に統一
      amount: creditToApply,
      reason: `initial signup (${appliedBy})`,
      meta: { eve: eve || null },
    };

    const { data, error: upErr } = await supabaseAdmin
      .from('credit_ledger')
      .upsert(row, { onConflict: 'user_code,entry_key' }) // ← 重複時は更新
      .select('*')
      .single();

    if (upErr) throw upErr;

    let screenshotGranted: boolean | null = null;
    let screenshotCreditError: string | null = null;

    try {
      const { data: granted, error: screenshotErr } = await supabaseAdmin.rpc(
        'grant_screenshot_credit',
        {
          p_user_code: user_code,
          p_amount: 1,
          p_reason: 'first_signup',
          p_campaign: 'first_signup',
        },
      );

      if (screenshotErr) throw screenshotErr;
      screenshotGranted = Boolean(granted);
    } catch (screenshotErr: any) {
      screenshotCreditError = screenshotErr?.message || String(screenshotErr);
      console.warn('[apply-initial-credit] screenshot credit grant skipped:', screenshotCreditError);
    }

    let firstFollowupGranted: boolean | null = null;
    let firstFollowupCreditError: string | null = null;

    try {
      const { data: granted, error: followupErr } = await supabaseAdmin.rpc(
        'grant_first_followup_credit',
        {
          p_user_code: user_code,
          p_amount: 3,
          p_reason: 'first_signup',
          p_campaign: 'first_signup',
        },
      );

      if (followupErr) throw followupErr;
      firstFollowupGranted = Boolean(granted);
    } catch (followupErr: any) {
      firstFollowupCreditError = followupErr?.message || String(followupErr);
      console.warn('[apply-initial-credit] first followup credit grant skipped:', firstFollowupCreditError);
    }

    return NextResponse.json({
      ok: true,
      applied_credit: creditToApply,
      applied_by: appliedBy,
      screenshot_credit_granted: screenshotGranted,
      screenshot_credit_error: screenshotCreditError,
      first_followup_credit_granted: firstFollowupGranted,
      first_followup_credit_error: firstFollowupCreditError,
      ledger: data,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'unknown error' }, { status: 500 });
  }
}
