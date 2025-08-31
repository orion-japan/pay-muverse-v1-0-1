// src/app/api/conv/create/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function POST() {
  try {
    const g = await verifyFirebaseAndAuthorize('skip'); // 認証ユーティリティ
    if (!g.allowed || !g.userCode) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const user_code = g.userCode; // ← text 形式

    const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

    const conversation_code = `Q${Date.now()}`;
    const { error } = await supabase.from('conversations').insert({
      user_code,                 // ← text で保存
      conversation_code,         // ← text で一意キー
      title: null,
      messages: [],
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.error('[conv/create] error', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ id: conversation_code }, { status: 200 });
  } catch (e: any) {
    console.error('[conv/create] fatal', e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
