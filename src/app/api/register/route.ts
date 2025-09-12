import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function POST(req: NextRequest) {
  try {
    const data = await req.json();

    const {
      nickname,
      email,
      password,
      phone_number,
      ref,
      click_type,
      '#user_code': userCode,
      '#Rcode': inviteCode,
      Mcode,
      free_count,
      DATE,
      eve // ★ 追加: イベントコード
    } = data;

    // ✅ デフォルトは45
    let creditToApply = 45;
    let appliedBy = 'default';

    // ✅ イベントコードがあれば invite_codes を確認
    if (eve) {
      const { data: invite, error } = await supabaseAdmin
        .from('invite_codes')
        .select('campaign_type, bonus_credit, code')
        .eq('code', eve)
        .maybeSingle();

      if (error) throw error;

      if (invite && invite.campaign_type === 'bonus-credit') {
        const v = Number(invite.bonus_credit ?? 45);
        if (!Number.isNaN(v) && v >= 0) {
          creditToApply = v; // ← 45を上書き
          appliedBy = `eve:${invite.code}`;
        }
      }
    }

    // ✅ ClickのWebhookエンドポイント
    const CLICK_WEBHOOK_URL = process.env.CLICK_WEBHOOK_URL;

    // ✅ Clickに送るペイロード
    const payload = {
      click_username: nickname,
      click_email: email,
      Password: password, // 本番はハッシュ化推奨
      Tcode: phone_number,
      ref: ref,
      click_type: click_type,
      '#user_code': userCode,
      '#Rcode': inviteCode,
      Mcode: Mcode,
      free_count: creditToApply, // ← free_count をイベントで上書き
      DATE: DATE,
      appliedBy // ★ デバッグ用（必要なら）
    };

    const res = await fetch(CLICK_WEBHOOK_URL!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error('Click送信エラー:', res.status, errorText);
      return NextResponse.json({ error: errorText }, { status: res.status });
    }

    console.log('Click送信成功:', await res.json());

    return NextResponse.json({ success: true, applied_credit: creditToApply, applied_by: appliedBy });
  } catch (e) {
    console.error('サーバー処理エラー:', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
