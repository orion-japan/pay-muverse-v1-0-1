import { NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin'; // 既存のFirebase Admin初期化ファイルを利用
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;



export async function POST(req: Request) {
  try {
    const { idToken } = await req.json().catch(() => ({}));

    if (!idToken) {
      return NextResponse.json({ error: 'idToken is required' }, { status: 400 });
    }

    // ① idToken 検証
    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(idToken, true);
    } catch (err) {
      console.error('[custom-token] Firebase IDトークン検証失敗', err);
      return NextResponse.json({ error: 'Invalid Firebase ID token' }, { status: 401 });
    }

    // ② customToken 発行
    let customToken;
    try {
      customToken = await adminAuth.createCustomToken(decoded.uid);
    } catch (err) {
      console.error('[custom-token] カスタムトークン生成失敗', err);
      return NextResponse.json({ error: 'Failed to create custom token' }, { status: 500 });
    }

    console.log(`[custom-token] カスタムトークン発行成功: uid=${decoded.uid}`);

    // ③ customToken を返す
    return NextResponse.json({ customToken }, { status: 200 });

  } catch (err) {
    console.error('[custom-token] API例外発生', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
