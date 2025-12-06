// app/api/admin/delete-user/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import admin, { ServiceAccount } from 'firebase-admin';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Firebase Admin 初期化（JSON 環境変数からのみ読む / ファイルは使わない）
let firebaseReady = false;

function initFirebaseAdmin() {
  if (firebaseReady) return;

  if (admin.apps.length) {
    firebaseReady = true;
    return;
  }

  const json = process.env.FIREBASE_ADMIN_CREDENTIALS_JSON;
  if (!json) {
    console.warn(
      '[admin/delete-user] FIREBASE_ADMIN_CREDENTIALS_JSON is not set; firebase admin will be skipped',
    );
    firebaseReady = false;
    return;
  }

  try {
    const serviceAccount = JSON.parse(json) as ServiceAccount;

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    firebaseReady = true;
  } catch (err) {
    console.warn(
      '[admin/delete-user] Firebase Admin init failed; firebase will be skipped',
      err,
    );
    firebaseReady = false;
  }
}

// モジュール読み込み時に一度だけ初期化を試みる
initFirebaseAdmin();

export async function POST(req: NextRequest) {
  const { user_code } = await req.json();
  if (!user_code) {
    return NextResponse.json(
      { ok: false, error: 'user_code is required' },
      { status: 400 },
    );
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('firebase_uid, payjp_customer_id')
    .eq('user_code', user_code)
    .single();

  if (error || !user) {
    return NextResponse.json(
      { ok: false, error: 'User not found' },
      { status: 404 },
    );
  }

  const results: Record<string, string> = {};

  // Firebase 削除
  try {
    if (!firebaseReady) {
      results.firebase = 'skipped (firebase admin not initialized)';
    } else if (user.firebase_uid) {
      await admin.auth().deleteUser(user.firebase_uid);
      results.firebase = 'deleted';
    } else {
      results.firebase = 'skipped (no firebase_uid)';
    }
  } catch (err: any) {
    results.firebase = `error: ${err.message}`;
  }

  // Supabase 削除
  try {
    await supabase.from('users').delete().eq('user_code', user_code);
    results.supabase = 'deleted';
  } catch (err: any) {
    results.supabase = `error: ${err.message}`;
  }

  // PAYJP は削除せず、存在するかどうかだけ返す
  if (user.payjp_customer_id) {
    results.payjp = 'customer exists (not deleted)';
  } else {
    results.payjp = 'none';
  }

  return NextResponse.json({ ok: true, results });
}
