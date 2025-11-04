export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const env = (k: string, req = true) => {
  const v = process.env[k];
  if (!v && req) throw new Error(`Missing env: ${k}`);
  return v ?? '';
};
const SUPABASE_URL = env('SUPABASE_URL');
const SERVICE_ROLE = env('SUPABASE_SERVICE_ROLE_KEY');
const BUCKET = 'fshot';

const sb = () => createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const json = (d: any, s = 200) =>
  new NextResponse(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });

export async function POST(req: NextRequest) {
  try {
    const { session_id, user_code, filename } = await req.json();
    if (!session_id || !user_code || !filename) return json({ error: 'missing params' }, 400);

    const key = `fshot/${user_code}/${session_id}/${crypto.randomUUID()}_${filename}`;
    const { data, error } = await sb().storage.from(BUCKET).createSignedUploadUrl(key);
    if (error) return json({ error: error.message }, 500);

    return json({ ok: true, key, signedUrl: data.signedUrl, token: data.token });
  } catch (e: any) {
    return json({ error: String(e.message || e) }, 500);
  }
}
