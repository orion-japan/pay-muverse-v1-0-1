import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET = process.env.NEXT_PUBLIC_SUPABASE_BUCKET || 'uploads';

export async function POST(req: Request) {
  try {
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return NextResponse.json({ ok: false, error: 'Supabase env not set' }, { status: 500 });
    }
    const { filename, prefix } = await req.json();
    if (!filename) {
      return NextResponse.json({ ok: false, error: 'filename required' }, { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // バケットが無ければ作成（public 推奨）
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.some((b) => b.name === BUCKET)) {
      const { error: be } = await supabase.storage.createBucket(BUCKET, { public: true });
      if (be)
        return NextResponse.json(
          { ok: false, error: `createBucket: ${be.message}` },
          { status: 500 },
        );
    }

    const ext = filename.split('.').pop()?.toLowerCase() || 'jpg';
    const y = new Date().getUTCFullYear();
    const m = String(new Date().getUTCMonth() + 1).padStart(2, '0');
    const rand = Math.random().toString(36).slice(2, 8);
    const path = `${prefix || 'mui'}/${y}/${m}/${crypto.randomUUID()}-${rand}.${ext}`;

    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data?.token) {
      return NextResponse.json(
        { ok: false, error: error?.message || 'sign failed' },
        { status: 500 },
      );
    }

    // ★ ここが重要：/sign/<bucket>/<path>
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${path}`;
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;

    return NextResponse.json({
      ok: true,
      bucket: BUCKET,
      path,
      token: data.token,
      uploadUrl,
      publicUrl,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'server error' }, { status: 500 });
  }
}
