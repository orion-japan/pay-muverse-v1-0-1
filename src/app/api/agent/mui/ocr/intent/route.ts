// app/api/agent/mui/ocr/intent/route.ts
export const runtime = 'nodejs';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function mustEnv(n: string) {
  const v = process.env[n];
  if (!v) throw new Error(`Missing ${n}`);
  return v;
}
const supa = createClient(
  mustEnv('NEXT_PUBLIC_SUPABASE_URL'),
  mustEnv('SUPABASE_SERVICE_ROLE_KEY'),
);

export async function POST(req: NextRequest) {
  const b = (await req.json()) as {
    user_code: string;
    seed_id: string;
    intent_text: string;
    intent_category: string;
  };
  const { error } = await supa
    .from('mui_ocr_seeds')
    .update({ intent_text: b.intent_text, intent_category: b.intent_category })
    .eq('seed_id', b.seed_id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
