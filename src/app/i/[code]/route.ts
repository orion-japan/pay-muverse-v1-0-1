// src/app/i/[code]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ code: string }> | { code: string } };

export async function GET(req: NextRequest, ctx: Params) {
  const params = await ctx.params;
  const code = params?.code?.trim();

  if (!code) {
    return NextResponse.redirect(new URL('/', req.url));
  }

  const { data, error } = await supabaseAdmin
    .from('invite_links')
    .select('id, destination_url, is_active, click_count')
    .eq('short_code', code)
    .maybeSingle();

  if (error || !data || !data.is_active) {
    return NextResponse.redirect(new URL('/register?invite_error=not_found', req.url));
  }

  await supabaseAdmin
    .from('invite_links')
    .update({
      click_count: Number(data.click_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', data.id);

  return NextResponse.redirect(data.destination_url, 302);
}
