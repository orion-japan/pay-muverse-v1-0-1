// /app/api/talk/mark-read/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { adminAuth } from '@/lib/firebase-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
})

async function uidToUserCode(uid: string): Promise<string | null> {
  const { data } = await sb
    .from('users')
    .select('user_code')
    .eq('firebase_uid', uid)
    .maybeSingle()
  return data?.user_code ?? null
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any))
    const thread_id: string | undefined =
      body?.thread_id ?? body?.conversation_id ?? body?.threadId ?? undefined

    if (!thread_id) {
      return NextResponse.json({ error: 'bad request' }, { status: 400 })
    }

    // ---- Firebase ID トークン検証 ----
    const authz = req.headers.get('authorization') || ''
    const token = authz.toLowerCase().startsWith('bearer ')
      ? authz.slice(7).trim()
      : ''

    let user_code: string | null = null
    if (token) {
      const decoded = await adminAuth.verifyIdToken(token).catch(() => null)
      if (decoded?.uid) {
        user_code = await uidToUserCode(decoded.uid)
      }
    }

    let last_read_at: string | null = null

    if (user_code) {
      const untilIso =
        typeof body?.until === 'string'
          ? new Date(body.until).toISOString()
          : new Date().toISOString()
      last_read_at = untilIso

      // ---- upsert ----
      await sb.from('talk_reads').upsert(
        { thread_id, user_code, last_read_at: untilIso },
        { onConflict: 'thread_id,user_code', ignoreDuplicates: false }
      )

      // ---- conditional update ----
      await sb
        .from('talk_reads')
        .update({ last_read_at: untilIso })
        .eq('thread_id', thread_id)
        .eq('user_code', user_code)
        .lt('last_read_at', untilIso)
    }

    return NextResponse.json(
      { ok: true, thread_id, last_read_at },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (e: any) {
    console.error('[Talk][mark-read] fatal', e)
    return NextResponse.json(
      { error: e?.message ?? 'unexpected' },
      { status: 500 }
    )
  }
}
