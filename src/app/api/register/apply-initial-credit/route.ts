import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { recordUserJourneyEvent } from '@/lib/userJourney';

const INITIAL_CHAT_CREDIT = 90;
const INITIAL_SCREENSHOT_CREDIT = 1;
const INITIAL_FIRST_FOLLOWUP_CREDIT = 3;

/**
 * POST /api/register/apply-initial-credit
 * Body: { user_code: string, eve?: string }
 *
 * - 通常は 90 クレジットを付与
 * - eve が指定され、invite_codes に一致すれば、その bonus_credit で上書き
 * - credit_ledger に entry_key='initial_signup' として upsert
 * - スクショ診断クレジットを 1 回分付与
 * - 初回診断後の追加相談クレジットを 3 回分付与
 */
export async function POST(req: NextRequest) {
  try {
    const { user_code, eve } = await req.json();

    if (!user_code) {
      return NextResponse.json({ ok: false, error: 'missing user_code' }, { status: 400 });
    }

    let creditToApply = INITIAL_CHAT_CREDIT;
    let appliedBy = 'default_90';

    if (eve) {
      const { data: invite, error } = await supabaseAdmin
        .from('invite_codes')
        .select('campaign_type, bonus_credit, code')
        .eq('code', eve)
        .maybeSingle();

      if (error) throw error;

      if (invite && invite.campaign_type === 'bonus-credit') {
        const v = Number(invite.bonus_credit ?? INITIAL_CHAT_CREDIT);
        if (!Number.isNaN(v) && v >= 0) {
          creditToApply = v;
          appliedBy = `eve:${invite.code}`;
        }
      }
    }

    const row = {
      user_code,
      entry_key: 'initial_signup',
      amount: creditToApply,
      reason: `initial signup (${appliedBy})`,
      meta: {
        eve: eve || null,
        initial_chat_credit: INITIAL_CHAT_CREDIT,
        initial_screenshot_credit: INITIAL_SCREENSHOT_CREDIT,
        initial_first_followup_credit: INITIAL_FIRST_FOLLOWUP_CREDIT,
      },
    };

    const { data, error: upErr } = await supabaseAdmin
      .from('credit_ledger')
      .upsert(row, { onConflict: 'user_code,entry_key' })
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
          p_amount: INITIAL_SCREENSHOT_CREDIT,
          p_reason: 'first_signup',
          p_campaign: 'first_signup',
        },
      );

      if (screenshotErr) throw screenshotErr;
      screenshotGranted = Boolean(granted);
    } catch (screenshotErr: any) {
      screenshotCreditError = screenshotErr?.message || String(screenshotErr);
      console.warn('[apply-initial-credit] screenshot credit grant skipped:', screenshotCreditError);

      const { data: userRow } = await supabaseAdmin
        .from('users')
        .select('screenshot_credit_count')
        .eq('user_code', user_code)
        .maybeSingle();

      const current = Number((userRow as any)?.screenshot_credit_count ?? 0);

      await supabaseAdmin
        .from('users')
        .update({ screenshot_credit_count: Math.max(current, INITIAL_SCREENSHOT_CREDIT) })
        .eq('user_code', user_code);
    }

    let firstFollowupGranted: boolean | null = null;
    let firstFollowupCreditError: string | null = null;

    try {
      const { data: granted, error: followupErr } = await supabaseAdmin.rpc(
        'grant_first_followup_credit',
        {
          p_user_code: user_code,
          p_amount: INITIAL_FIRST_FOLLOWUP_CREDIT,
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

    await recordUserJourneyEvent({
      userCode: user_code,
      eventName: 'initial_credit_granted',
      source: 'register',
      campaign: eve || null,
      metadata: {
        chatCredit: creditToApply,
        screenshotCredit: INITIAL_SCREENSHOT_CREDIT,
        firstFollowupCredit: INITIAL_FIRST_FOLLOWUP_CREDIT,
        appliedBy,
      },
    });

    return NextResponse.json({
      ok: true,
      applied_credit: creditToApply,
      screenshot_credit: INITIAL_SCREENSHOT_CREDIT,
      screenshot_credit_granted: screenshotGranted,
      screenshot_credit_error: screenshotCreditError,
      first_followup_credit: INITIAL_FIRST_FOLLOWUP_CREDIT,
      first_followup_credit_granted: firstFollowupGranted,
      first_followup_credit_error: firstFollowupCreditError,
      applied_by: appliedBy,
      ledger: data,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'unknown error' }, { status: 500 });
  }
}
