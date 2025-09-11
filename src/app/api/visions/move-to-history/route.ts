// src/app/api/visions/move-to-history/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { createClient } from '@supabase/supabase-js';

const USE_STATUS_COLUMN = false;

// ★ Service Role で確実に更新（RLSをバイパス）
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

// Firebase Admin init
try {
  initializeApp({ credential: applicationDefault() });
} catch {
  /* noop: already initialized */
}

type Body = { visionId?: string; userCode?: string };

export async function POST(req: NextRequest) {
  console.log('📥 [move-to-history] called');

  try {
    // 認証（Firebase）
    const authz = req.headers.get('authorization') || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice('Bearer '.length) : null;
    if (!idToken) {
      console.warn('❌ No ID token');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const decoded = await getAuth().verifyIdToken(idToken).catch(() => null);
    if (!decoded?.uid) {
      console.warn('❌ Invalid token');
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const visionId = (body.visionId || '').trim();
    const userCode = (body.userCode || '').trim();
    if (!visionId) {
      console.warn('❌ Missing visionId');
      return NextResponse.json({ error: 'Missing visionId' }, { status: 400 });
    }

    const nowIso = new Date().toISOString();
    const patch = USE_STATUS_COLUMN
      ? { status: 'history', updated_at: nowIso }
      : { moved_to_history_at: nowIso, updated_at: nowIso };

    console.log('📤 [move-to-history] update start', { visionId, userCode, patch });

    let q = admin
      .from('visions')
      .update(patch)
      .eq('vision_id', visionId)
      .select('vision_id, title, user_code, status, moved_to_history_at, updated_at')
      .single();

    if (userCode) {
      q = admin
        .from('visions')
        .update(patch)
        .eq('vision_id', visionId)
        .eq('user_code', userCode)
        .select('vision_id, title, user_code, status, moved_to_history_at, updated_at')
        .single();
    }

    const { data, error, status } = await q;
    console.log('📥 [move-to-history] result', { data, error, status });

    if (error) {
      console.error('❌ [move-to-history] supabase error', error);
      return NextResponse.json({ error: error.message, status }, { status: 500 });
    }
    if (!data) {
      console.warn('⚠️ [move-to-history] Not found or no permission');
      return NextResponse.json({ error: 'Not found or no permission' }, { status: 404 });
    }

    if (!USE_STATUS_COLUMN && !data.moved_to_history_at) {
      console.error('❌ [move-to-history] Update did not apply', data);
      return NextResponse.json(
        { error: 'Update did not apply (moved_to_history_at is null)', data },
        { status: 500 }
      );
    }

    console.log('✅ [move-to-history] success', data);
    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    console.error('❌ [move-to-history] unexpected error', e);
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: 500 });
  }
}
