// /api/update-name-visibility/route.ts（例）
import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { supabaseServer } from '@/lib/supabaseServer';

export async function POST(req: NextRequest) {
  const { show } = await req.json(); // boolean
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return NextResponse.json({ error: 'no token' }, { status: 401 });

  const decoded = await adminAuth.verifyIdToken(token, true);
  const { data: me } = await supabaseServer
    .from('users')
    .select('user_code')
    .eq('firebase_uid', decoded.uid)
    .single();

  if (!me) return NextResponse.json({ error: 'user not found' }, { status: 404 });

  const { error } = await supabaseServer
    .from('users')
    .update({ show_name_to_mates: !!show })
    .eq('user_code', me.user_code);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
