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
  click_username?: string | null
  avatar_url?: string | null
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const threadId = searchParams.get('threadId')

  if (!threadId) {
    return NextResponse.json({ error: 'Missing threadId' }, { status: 400 })
  }

  try {
    // 1) 親（is_thread を優先）
    let originalPost: Post | null = null

    const { data: withFlag, error: ofErr } = await supabase
      .from('posts')
      .select('post_id,user_code,content,created_at,thread_id,parent_board,is_thread')
      .eq('post_id', threadId)
      .eq('is_thread', true)
      .maybeSingle()

    if (ofErr) {
      // ログだけ（is_thread が無い環境も想定）
      console.warn('[thread-posts] is_thread check warn:', ofErr.message)
    }
    if (withFlag) originalPost = withFlag as Post

    if (!originalPost) {
      const { data, error } = await supabase
        .from('posts')
        .select('post_id,user_code,content,created_at,thread_id,parent_board')
        .eq('post_id', threadId)
        .single()
      if (error || !data) {
        console.error('[thread-posts] original not found:', error)
        return NextResponse.json({ error: 'Original post not found' }, { status: 404 })
      }
      originalPost = data as Post
    }

    // 2) 返信（thread_id → parent_board）
    let replies: Post[] = []
    const { data: byThreadId, error: e1 } = await supabase
      .from('posts')
      .select('post_id,user_code,content,created_at,thread_id,parent_board')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })

    if (!e1 && Array.isArray(byThreadId) && byThreadId.length) {
      replies = byThreadId as Post[]
    } else {
      const { data: byParent, error: e2 } = await supabase
        .from('posts')
        .select('post_id,user_code,content,created_at,thread_id,parent_board')
        .eq('parent_board', threadId)
        .order('created_at', { ascending: true })
      if (!e2 && Array.isArray(byParent)) replies = byParent as Post[]
    }

    // 重複除去（念のため）
    const allMap = new Map<string, Post>()
    allMap.set(originalPost.post_id, originalPost)
    for (const r of replies) allMap.set(r.post_id, r)
    const all = Array.from(allMap.values())

    // 3) profiles から name / avatar_url を一括取得
    const codes = Array.from(new Set(all.map(p => p?.user_code).filter(Boolean) as string[]))

    const nameMap = new Map<string, string | null>()
    const avatarMap = new Map<string, string | null>()

    if (codes.length > 0) {
      const { data: profilesRows, error: pErr } = await supabase
        .from('profiles')
        .select('user_code,name,avatar_url')
        .in('user_code', codes)

      if (pErr) {
        console.error('[thread-posts] profiles fetch error:', pErr)
      } else {
        profilesRows?.forEach((p: any) => {
          nameMap.set(p.user_code, p.name ?? null)
          avatarMap.set(p.user_code, p.avatar_url ?? null)
        })
      }
    }

    const enriched: Post[] = all.map(p => ({
      ...p,
      click_username: (p.user_code && nameMap.get(p.user_code)) ?? null,
      avatar_url: (p.user_code && avatarMap.get(p.user_code)) ?? null,
    }))

    // キャッシュしない（常に新鮮）
    return NextResponse.json(enriched, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[thread-posts] unexpected:', e)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
