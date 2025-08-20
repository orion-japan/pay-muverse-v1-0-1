import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

type Body = { threadId?: string; userCode?: string; content?: string }

export async function POST(req: NextRequest) {
  try {
    const { threadId, userCode, content } = (await req.json()) as Body
    if (!threadId || !userCode || !content?.trim()) {
      return NextResponse.json({ error: 'bad request' }, { status: 400 })
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const key =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! // SRK未設定でも一応動く

    const admin = createClient(url, key, { auth: { persistSession: false } })

    // コメント挿入
    const { data: inserted, error } = await admin
      .from('posts')
      .insert({
        thread_id: String(threadId),
        user_code: String(userCode),
        content: content.trim(),
        is_posted: false,
      })
      .select('post_id,user_code,content,created_at,thread_id,is_posted')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // 参加者へアプリ内通知（ベストエフォート）
    try {
      const { data: rows } = await admin
        .from('posts')
        .select('user_code')
        .eq('thread_id', String(threadId))

      const set = new Set<string>()
      rows?.forEach((r: any) => r.user_code && r.user_code !== userCode && set.add(r.user_code))
      const notifRows = [...set].map((to) => ({
        recipient_user_code: to,
        from_user_code: userCode,
        title: '新しいコメント',
        body: content.slice(0, 80),
        url: `/thread/${threadId}`,
      }))
      if (notifRows.length) await admin.from('notifications').insert(notifRows)
    } catch {
      /* no-op */
    }

    return NextResponse.json(inserted, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'internal error' }, { status: 500 })
  }
}
