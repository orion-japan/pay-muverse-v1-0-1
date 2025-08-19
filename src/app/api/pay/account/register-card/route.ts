// src/app/api/pay/account/register-card/route.ts
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import Payjp from 'payjp';
import https from 'node:https';
import { adminAuth } from '@/lib/firebase-admin'; // 既存のadminAuthを利用

// ✅ PAY.JP 初期化（タイムアウト120秒 / 2回リトライ / KeepAlive）
const agent = new https.Agent({ keepAlive: true });
const payjp = Payjp(process.env.PAYJP_SECRET_KEY || '', {
  timeout: 120_000,
  maxRetries: 2,
  httpAgent: agent,
});

export async function POST(req: Request) {
  console.log('📩 [/register-card] API HIT');
  const t0 = Date.now();

  try {
    const authHeader = req.headers.get('authorization') || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    const { token, user_code: userCodeFromBody } = await req.json().catch(() => ({}));
    console.log('🟢 受信データ:', { user_code: userCodeFromBody || '(auto)', token: token?.slice(0, 8) });

    if (!token) {
      return NextResponse.json({ error: 'card token がありません' }, { status: 400 });
    }

    // 1) Firebaseトークンがあればそれ最優先で本人特定
    let firebase_uid: string | null = null;
    let emailFromToken: string | null = null;
    if (idToken) {
      try {
        const decoded: any = await adminAuth.verifyIdToken(idToken, true);
        firebase_uid = decoded?.uid ?? null;
        emailFromToken = decoded?.email ?? null;
      } catch {
        // トークン無効でもフォールバック検索へ
        console.warn('⚠️ Firebaseトークン検証失敗。フォールバック検索に切り替えます。');
      }
    }

    // 2) ユーザー特定（順序: user_code → firebase_uid → email）
    let user_code: string | null = null;
    let click_email: string | null = null;
    let payjp_customer_id: string | null = null;

    console.time('⏱ Supabase:ユーザー取得');

    if (userCodeFromBody) {
      const { data, error } = await supabase
        .from('users')
        .select('user_code, click_email, payjp_customer_id')
        .eq('user_code', userCodeFromBody)
        .maybeSingle();
      if (data) {
        user_code = data.user_code;
        click_email = data.click_email;
        payjp_customer_id = data.payjp_customer_id;
      } else if (error) {
        console.warn('user_code指定で取得失敗:', error.message);
      }
    }

    if (!user_code && firebase_uid) {
      const { data, error } = await supabase
        .from('users')
        .select('user_code, click_email, payjp_customer_id')
        .eq('firebase_uid', firebase_uid)
        .maybeSingle();
      if (data) {
        user_code = data.user_code;
        click_email = data.click_email;
        payjp_customer_id = data.payjp_customer_id;
      } else if (error) {
        console.warn('firebase_uidで取得失敗:', error.message);
      }
    }

    if (!user_code && (emailFromToken || click_email)) {
      const email = emailFromToken || click_email!;
      const { data, error } = await supabase
        .from('users')
        .select('user_code, click_email, payjp_customer_id, firebase_uid')
        .eq('click_email', email)
        .maybeSingle();
      if (data) {
        user_code = data.user_code;
        click_email = data.click_email;
        payjp_customer_id = data.payjp_customer_id;
        // uid 未同期なら同期しておく（任意）
        if (firebase_uid && data.firebase_uid !== firebase_uid) {
          await supabase.from('users').update({ firebase_uid }).eq('user_code', data.user_code);
        }
      } else if (error) {
        console.warn('email検索で取得失敗:', error.message);
      }
    }

    console.timeEnd('⏱ Supabase:ユーザー取得');

    if (!user_code || !click_email) {
      return NextResponse.json(
        { error: 'ユーザーの特定に失敗しました（user_code / uid / email）' },
        { status: 404 }
      );
    }

    // 3) PAY.JP: customer作成 or 既存customerにカード追加
    let customerId = payjp_customer_id;

    if (!customerId) {
      console.time('⏱ PAY.JP customer作成');
      const customer = await payjp.customers.create({
        email: click_email,
        card: token, // 同時にカードも登録
        metadata: { user_code },
      });
      console.timeEnd('⏱ PAY.JP customer作成');

      customerId = customer.id;

      // 顧客ID保存
      console.time('⏱ Supabase:顧客ID保存');
      const { error: updErr } = await supabase
        .from('users')
        .update({ payjp_customer_id: customerId, card_registered: true })
        .eq('user_code', user_code);
      console.timeEnd('⏱ Supabase:顧客ID保存');

      if (updErr) {
        console.error('❌ Supabase更新エラー:', updErr.message);
        return NextResponse.json({ error: 'Supabase更新エラー', detail: updErr.message }, { status: 500 });
      }
      console.log('✅ 新規customer作成＆保存完了:', customerId);
    } else {
      // 既存 customer にカード追加
      console.time('⏱ PAY.JP カード追加');
      await payjp.customers.createCard(customerId, { card: token });
      console.timeEnd('⏱ PAY.JP カード追加');

      // フラグだけ更新
      await supabase.from('users').update({ card_registered: true }).eq('user_code', user_code);
      console.log('✅ 既存customerにカード追加:', customerId);
    }

    console.log(`⏳ API 全体処理時間: ${Date.now() - t0}ms`);
    return NextResponse.json({ success: true, customer_id: customerId }, { status: 200 });
  } catch (err: any) {
    console.error('⨯ カード登録処理エラー:', err?.message || err);
    return NextResponse.json(
      { success: false, error: 'カード登録に失敗しました', detail: String(err) },
      { status: 500 }
    );
  }
}
