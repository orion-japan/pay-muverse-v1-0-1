// src/app/api/secure-action/route.ts
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { adminAuth as firebaseAdminAuth } from '@/lib/firebase-admin';

// 共通のIDトークン検証
async function verifyUser(req: Request) {
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) throw new Error('Missing token');

  const decoded = await firebaseAdminAuth.verifyIdToken(token);
  return decoded.uid; // Firebase UID
}

export async function POST(req: Request) {
  try {
    const uid = await verifyUser(req);
    const { someData } = await req.json();

    // ✅ RLS下でのINSERT
    const { data, error } = await supabase
      .from('posts') // ← 対象テーブル
      .insert([{ user_id: uid, content: someData }])
      .select();

    if (error) throw error;
    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 401 });
  }
}
