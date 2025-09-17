import { NextResponse, NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SB_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SRV =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

const mask = (v?: string) => (!v ? 'undefined' : `${v.slice(0, 4)}…(len:${v.length})`);
const projectRef = (u: string) => {
  try {
    // グローバルの URL コンストラクタを明示的に使用
    return new globalThis.URL(u).host.split('.')[0];
  } catch {
    return '';
  }
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const ref = projectRef(SB_URL);
  let adminPing: any = null;
  let adminErr: any = null;

  try {
    if (!SB_URL) throw new Error('URL missing');
    if (!SRV) throw new Error('SERVICE_ROLE missing');

    const admin = createClient(SB_URL, SRV, { auth: { persistSession: false } });
    const { data, error } = await admin.from('mu_conversations').select('id').limit(1);

    if (error) {
      adminErr = {
        message: error.message,
        details: (error as any).details ?? null,
        hint: (error as any).hint ?? null,
      };
    } else {
      adminPing = { ok: true, rows: data?.length ?? 0 };
    }
  } catch (e: any) {
    adminErr = { message: String(e?.message ?? e) };
  }

  return NextResponse.json({
    env_seen_by_server: {
      project_url: SB_URL || 'undefined',
      project_ref: ref || 'undefined',
      service_role: mask(SRV),
      anon_key: mask(ANON),
    },
    admin_ping_result: adminPing,
    admin_ping_error: adminErr,
  });
}
