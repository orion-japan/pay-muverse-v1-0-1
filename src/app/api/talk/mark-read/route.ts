import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const { thread_id, user_code, until } = await req.json()
    if (!thread_id || !user_code) {
      return NextResponse.json({ error: 'bad request' }, { status: 400 })
    }

    const { error } = await supabaseAdmin
      .from('chats')
      .update({ read_at: new Date().toISOString() })
      .eq('thread_id', thread_id)
      .eq('receiver_code', user_code)
      .lte('created_at', until ?? new Date().toISOString())

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[Talk][read]', e)
    return NextResponse.json({ error: e?.message || 'unexpected' }, { status: 500 })
  }
}
