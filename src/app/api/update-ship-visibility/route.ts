export const runtime = 'nodejs'; // ← 秘密ENVを読むため必須

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { adminAuth } from '@/lib/firebase-admin';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('ENV CHECK /api/update-ship-visibility:', {
    url: !!SUPABASE_URL,
    sr: !!SERVICE_ROLE,
  });
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

export async function POST(req: NextRequest) {
  try {
    const { ship_visibility } = await req.json();

    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return NextResponse.json({ error: 'no token' }, { status: 401 });

    const decoded = await adminAuth.verifyIdToken(token, true);

    const { error } = await supabase
      .from('users')
      .update({ ship_visibility })
      .eq('firebase_uid', decoded.uid);

    if (error) {
      console.error('update-ship-visibility supabase error:', error);
      return NextResponse.json({ error: 'update failed' }, { status: 500 });
    }

    return NextResponse.json({ success: true, ship_visibility });
  } catch (e) {
    console.error('update-ship-visibility POST error:', e);
    return NextResponse.json({ error: 'server error' }, { status: 500 });
  }
}
