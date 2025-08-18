// src/app/api/thread-posts/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabaseClient'

type Post = {
  post_id: string
  user_code: string | null
  content: string
  created_at: string
  thread_id?: string | null
  parent_board?: string | null
  // ここに後で付与する
  click_username?: string | null   // ← profiles.name を入れる
  avatar_url?: string | null       // ← profiles.avatar_url を入れる
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const threadId = searchParams.get('threadId')

  if (!threadId) {
    return NextResponse.json({ error: 'Missing threadId' }, { status: 400 })
  }

  try {
    // 1) 親つぶやき（is_thread を優先、なければ post_id 一致）
    let originalPost: Post | null = null

    const { data: withFlag } = await supabase
      .from('posts')
      .select('*')
      .eq('post_id', threadId)
      .eq('is_thread', true)
      .maybeSingle()

    if (withFlag) originalPost = withFlag as Post

    if (!originalPost) {
      const { data, error } = await supabase
        .from('posts')
        .select('*')
        .eq('post_id', threadId)
        .single()
      if (error || !data) {
        console.error('[thread-posts] original not found:', error)
        return NextResponse.json({ error: 'Original post not found' }, { status: 404 })
      }
      originalPost = data as Post
    }

    // 2) 返信（thread_id 優先、無ければ parent_board）
    let replies: Post[] = []
    const { data: byThreadId, error: e1 } = await supabase
      .from('posts')
      .select('*')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })
    if (!e1 && Array.isArray(byThreadId) && byThreadId.length) {
      replies = byThreadId as Post[]
    } else {
      const { data: byParent, error: e2 } = await supabase
        .from('posts')
        .select('*')
        .eq('parent_board', threadId)
        .order('created_at', { ascending: true })
      if (!e2 && Array.isArray(byParent)) replies = byParent as Post[]
    }

    const all = [originalPost, ...replies]

    // 3) profiles から名前とアイコンをまとめて取得（✅ profiles.name / profiles.avatar_url を使用）
    const codes = Array.from(
      new Set(all.map(p => p?.user_code).filter(Boolean) as string[])
    )

    const nameMap = new Map<string, string | null>()
    const avatarMap = new Map<string, string | null>()

    if (codes.length > 0) {
      const { data: profilesRows, error: pErr } = await supabase
        .from('profiles')
        .select('user_code, name, avatar_url')
        .in('user_code', codes)

      if (pErr) {
        console.error('[thread-posts] profiles fetch error:', pErr)
      } else {
        profilesRows?.forEach((p: any) => {
          nameMap.set(p.user_code, p.name ?? null)          // ← name
          avatarMap.set(p.user_code, p.avatar_url ?? null)  // ← avatar_url
        })
      }
    }

    const enriched: Post[] = all.map(p => ({
      ...p,
      // ✅ 表示名は profiles.name を click_username に格納して返す（構造は維持）
      click_username: (p.user_code && nameMap.get(p.user_code)) ?? null,
      // ✅ アイコンも profiles.avatar_url を優先
      avatar_url: (p.user_code && avatarMap.get(p.user_code)) ?? null,
    }))

    return NextResponse.json(enriched)
  } catch (e) {
    console.error('[thread-posts] unexpected:', e)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
