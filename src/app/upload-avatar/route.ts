// /src/app/api/upload-avatar/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { supabaseAdmin } from '../../lib/supabaseAdmin';

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const idToken = (form.get('idToken') as string | null) || null;
    let uid = (form.get('uid') as string | null) || null;

    if (!file) {
      return NextResponse.json({ success: false, error: 'Missing file' }, { status: 400 });
    }

    if (idToken) {
      const decoded = await adminAuth.verifyIdToken(idToken, true);
      uid = decoded.uid;
    }
    if (!uid) {
      return NextResponse.json(
        { success: false, error: 'Missing uid (no idToken/uid)' },
        { status: 400 },
      );
    }

    // firebase_uid -> user_code
    const { data: userRow, error: userErr } = await supabaseAdmin
      .from('users')
      .select('user_code')
      .eq('firebase_uid', uid)
      .maybeSingle();

    if (userErr) {
      console.error('[upload-avatar] users query error', userErr);
      return NextResponse.json(
        { success: false, error: 'failed to fetch user_code' },
        { status: 500 },
      );
    }
    if (!userRow?.user_code) {
      return NextResponse.json({ success: false, error: 'user_code not found' }, { status: 404 });
    }

    const user_code = userRow.user_code as string;
    const filePath = `${user_code}/avatar.png`;

    const buf = Buffer.from(await (file as Blob).arrayBuffer());

    const { error: upErr } = await supabaseAdmin.storage.from('avatars').upload(filePath, buf, {
      upsert: true,
      contentType: file.type || 'image/png',
      cacheControl: '3600',
    });

    if (upErr) {
      console.error('[upload-avatar] storage upload error', upErr);
      return NextResponse.json({ success: false, error: upErr.message }, { status: 400 });
    }

    const { error: profErr } = await supabaseAdmin
      .from('profiles')
      .upsert({ user_code, avatar_url: filePath, updated_at: new Date().toISOString() });

    if (profErr) {
      console.error('[upload-avatar] profiles upsert error', profErr);
      return NextResponse.json({ success: false, error: profErr.message }, { status: 400 });
    }

    const { data: pub } = supabaseAdmin.storage.from('avatars').getPublicUrl(filePath);

    return NextResponse.json({ success: true, filePath, publicUrl: pub.publicUrl });
  } catch (e: any) {
    console.error('[upload-avatar] exception', e?.message || e);
    return NextResponse.json({ success: false, error: 'internal error' }, { status: 500 });
  }
}
