import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/talk/messages?thread_id=...&limit=50&cursor=...
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const thread_id = searchParams.get('thread_id') || ''
    const limit = Math.min(Number(searchParams.get('limit') || 50), 200)
    const cursor = searchParams.get('cursor')

    if (!thread_id) {
      return NextResponse.json({ error: 'thread_id required' }, { status: 400 })
    }

    let q = supabaseAdmin
      .from('chats')
      .select('*')
      .eq('thread_id', thread_id)
      .order('created_at', { ascending: true })
      .limit(limit)

    if (cursor) q = q.gt('created_at', cursor)

    const { data, error } = await q
    if (error) throw error

    return NextResponse.json({ items: data ?? [] })
  } catch (e: any) {
    console.error('[Talk][GET]', e)
    return NextResponse.json({ error: e?.message || 'unexpected' }, { status: 500 })
  }
}

// POST /api/talk/messages
// body: { a_code, b_code, sender_code, body }
// ※ DB の thread_id は「生成カラム」なので送らない！insert 後に返却値から取得。
export async function POST(req: Request) {
  try {
    const { a_code, b_code, sender_code, body } = await req.json()

    if (!a_code || !b_code || !sender_code || !body) {
      return NextResponse.json({ error: 'bad request' }, { status: 400 })
    }

    const receiver_code = sender_code === a_code ? b_code : a_code

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('chats')
      .insert({
        sender_code,
        receiver_code,
        message: body, // ← DB カラム名は message
      })
      .select('thread_id')
      .single()
    if (insErr) throw insErr

    const finalThreadId = inserted?.thread_id as string

    // 任意：スレッドメタ更新
    await supabaseAdmin.from('chat_threads').upsert(
      {
        thread_id: finalThreadId,
        a_code,
        b_code,
        last_message: String(body).slice(0, 200),
        last_message_at: new Date().toISOString(),
      },
      { onConflict: 'thread_id' }
    )

    return NextResponse.json({ ok: true, thread_id: finalThreadId })
  } catch (e: any) {
    console.error('[Talk][POST]', e)
    return NextResponse.json({ error: e?.message || 'unexpected', details: e }, { status: 500 })
  }
}
