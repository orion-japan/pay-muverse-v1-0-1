import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { adminAuth } from '@/lib/firebase-admin';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('ENV CHECK update-ship-visibility:', {
    url: !!SUPABASE_URL,
    sr: !!SERVICE_ROLE,
  });
  throw new Error('Env missing: SUPABASE_URL or SERVICE_ROLE');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

export async function POST(req: NextRequest) {
  try {
    const { ship_visibility } = await req.json();
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return NextResponse.json({ error: '認証トークンがありません' }, { status: 401 });
    }

    let decoded: any;
    try {
      decoded = await adminAuth.verifyIdToken(token, true);
    } catch {
      return NextResponse.json({ error: '無効なトークンです' }, { status: 403 });
    }

    const firebase_uid: string = decoded.uid;

    // ship_visibility 更新
    const { error } = await supabase
      .from('users')
      .update({ ship_visibility })
      .eq('firebase_uid', firebase_uid);

    if (error) {
      console.error('update-ship-visibility error:', error);
      return NextResponse.json({ error: '更新に失敗しました' }, { status: 500 });
    }

    return NextResponse.json({ success: true, ship_visibility });
  } catch (err: any) {
    console.error('update-ship-visibility POST error:', err?.message || err);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
