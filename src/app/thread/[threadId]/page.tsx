'use client'

import { useParams, useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { supabase } from '@/lib/supabase' // ✅ Realtime 用に追加
import './ThreadPage.css'

type Post = {
  post_id: string
  content: string
  created_at: string
  click_username?: string | null
  user_code?: string | null
  avatar_url?: string | null
  media_urls?: string[]
}

const DEFAULT_AVATAR = '/iavatar_default.png'

// self と同様：署名URLを返すAPIを通して表示
const avatarSrcFrom = (user_code?: string | null) =>
  user_code ? `/api/avatar/${encodeURIComponent(user_code)}` : DEFAULT_AVATAR

export default function ThreadPage() {
  const params = useParams()
  const router = useRouter()
  const { idToken, userCode } = useAuth()

  const threadIdParam =
    Array.isArray(params?.threadId) ? params.threadId[0] : (params?.threadId as string | undefined)
  const threadId = typeof threadIdParam === 'string' ? threadIdParam : ''

  const [posts, setPosts] = useState<Post[]>([])
  const [newComment, setNewComment] = useState('')
  const [loading, setLoading] = useState(true)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const fetchPosts = async () => {
    if (!threadId) {
      setErrMsg('スレッドIDが不正です')
      setLoading(false)
      return
    }
    setErrMsg(null)
    try {
      const res = await fetch(`/api/thread-posts?threadId=${encodeURIComponent(threadId)}`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        setErrMsg(`取得に失敗しました (${res.status})`)
        console.error('[ThreadPage] fetch failed:', res.status, t)
        return
      }
      const data: Post[] = await res.json()
      if (!Array.isArray(data)) {
        setErrMsg('データ形式が不正です')
        console.error('[ThreadPage] data not array:', data)
        return
      }
      setPosts(data)
    } catch (e) {
      console.error('[ThreadPage] fetch exception:', e)
      setErrMsg('取得時にエラーが発生しました')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    fetchPosts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  const handlePost = async () => {
    const text = newComment.trim()
    if (!text || !threadId) return

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (idToken) headers.Authorization = `Bearer ${idToken}`

    try {
      const res = await fetch('/api/create-thread-post', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          thread_id: threadId,
          content: text,
          board_type: 'self',
          user_code: userCode ?? null,
        }),
      })
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '')
        alert(`送信に失敗しました (${res.status})`)
        console.error('[ThreadPage] post failed', res.status, bodyText)
        return
      }
      const created: Post = await res.json()
      setNewComment('')
      setPosts((prev) => [...prev, created])

      requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
      })
    } catch (e) {
      console.error('[ThreadPage] post exception', e)
      alert('送信時にエラーが発生しました。')
    }
  }

  // 常に最新へスクロール
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [posts])

  // ✅ Realtime 購読（親: post_id、子: parent_post_id）
  useEffect(() => {
    if (!threadId) return

    // 親ポストの変更
    const upsertParent = (row: any) => {
      setPosts((prev) => {
        if (!prev.length) return [row]
        // 親は配列先頭という前提を維持
        if (prev[0]?.post_id === row.post_id) {
          const next = [...prev]
          next[0] = { ...next[0], ...row }
          return next
        }
        // もし親がまだいない場合は先頭に差し込み
        return [row, ...prev]
      })
    }

    // 子ポストの変更
    const upsertChild = (row: any) => {
      // children は posts[1..] として保持。created_at 昇順で並べる
      setPosts((prev) => {
        if (!prev.length) return prev // 親未ロード時は無視（初回 fetch 後に届く想定）
        const parent = prev[0]
        const children = prev.slice(1)
        const idx = children.findIndex((c) => c.post_id === row.post_id)
        if (idx === -1) {
          const merged = [...children, row].sort(
            (a, b) => +new Date(a.created_at) - +new Date(b.created_at)
          )
          return [parent, ...merged]
        } else {
          const next = [...children]
          next[idx] = { ...next[idx], ...row }
          next.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
          return [parent, ...next]
        }
      })
    }

    const removeChild = (row: any) => {
      setPosts((prev) => {
        if (!prev.length) return prev
        const parent = prev[0]
        const children = prev.slice(1).filter((c) => c.post_id !== row.post_id)
        return [parent, ...children]
      })
    }

    const channel = supabase
      .channel(`thread:${threadId}`)
      // 親（post_id が一致）
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'posts', filter: `post_id=eq.${threadId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            // 親削除の扱いは任意：ここでは一覧を空に
            setPosts([])
          } else {
            upsertParent(payload.new)
          }
        }
      )
      // 子（parent_post_id が一致）
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'posts', filter: `parent_post_id=eq.${threadId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') removeChild(payload.old)
          else upsertChild(payload.new)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [threadId])

  // 親＝配列先頭
  const parent = posts[0] || null

  const goProfile = (targetCode?: string | null) => {
    if (!targetCode) return;

    // ✅ 自分自身ならマイページへ
    if (userCode && targetCode === userCode) {
      router.push('/mypage');
    } else {
      // ✅ 他人なら /profile/[code]
      router.push(`/profile/${encodeURIComponent(targetCode)}`);
    }
  };

  // 子リスト
  const children = (() => {
    const arr = posts.slice(1)
    if (!parent || arr.length === 0) return arr
    const first = arr[0]
    const isDup =
      first.post_id === parent.post_id ||
      (first.content === parent.content &&
        Math.abs(new Date(first.created_at).getTime() - new Date(parent.created_at).getTime()) <
          5 * 60 * 1000)
    return isDup ? arr.slice(1) : arr
  })()

  return (
    <div className="thread-grid">
      {/* 親ヘッダー */}
      <header className="thread-header">
        <button className="back-btn" onClick={() => router.back()} aria-label="戻る">
          ← 戻る
        </button>

        {/* ✅ アイコン & 名前をクリックでプロフィールへ */}
        <img
          src={avatarSrcFrom(parent?.user_code)}
          alt="avatar"
          className="avatar"
          width={44}
          height={44}
          onClick={() => goProfile(parent?.user_code)}
          style={{ cursor: parent?.user_code ? 'pointer' : 'default' }}
          onError={(e) => {
            const el = e.currentTarget as HTMLImageElement
            if (el.dataset.fallbackApplied === '1') return
            el.dataset.fallbackApplied = '1'
            el.src = DEFAULT_AVATAR
          }}
        />

        <div className="header-info">
          <div className="header-title">
            <strong
              style={{ cursor: parent?.user_code ? 'pointer' : 'default' }}
              onClick={() => goProfile(parent?.user_code)}
            >
              {parent?.click_username || parent?.user_code || 'スレッド'}
            </strong>
            <small>{parent ? new Date(parent.created_at).toLocaleString('ja-JP') : ''}</small>
          </div>
          {parent?.content ? <p className="header-text">{parent.content}</p> : null}
        </div>
      </header>

      {/* 子コメント */}
      <main className="thread-scroll" ref={listRef}>
        {loading && <div className="meta">読み込み中...</div>}
        {errMsg && <div className="meta" style={{ color: '#ff9aa2' }}>{errMsg}</div>}

        {children.map((post) => (
          <article key={post.post_id} className="post">
            <div className="author-line">
              <img
                className="avatar child"
                src={avatarSrcFrom(post.user_code)}
                alt="avatar"
                width={32}
                height={32}
                style={{ cursor: post.user_code ? 'pointer' : 'default' }}
                onClick={() => goProfile(post.user_code)}
                onError={(e) => {
                  const el = e.currentTarget as HTMLImageElement
                  if (el.dataset.fallbackApplied === '1') return
                  el.dataset.fallbackApplied = '1'
                  el.src = DEFAULT_AVATAR
                }}
              />
              <div className="author-meta">
                <strong
                  style={{ cursor: post.user_code ? 'pointer' : 'default' }}
                  onClick={() => goProfile(post.user_code)}
                >
                  {post.click_username || post.user_code || 'unknown'}
                </strong>
                <span>{new Date(post.created_at).toLocaleString('ja-JP')}</span>
              </div>
            </div>
            <div className="content">{post.content}</div>
          </article>
        ))}
      </main>

      {/* 入力ボックス */}
      <footer className="post-form">
        <textarea
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          placeholder="コメントを入力..."
        />
        <button onClick={handlePost} disabled={!newComment.trim()}>
          送信
        </button>
      </footer>
    </div>
  )
}
