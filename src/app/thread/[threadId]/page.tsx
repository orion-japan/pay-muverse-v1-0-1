'use client'

import { useParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import './ThreadPage.css'

type Post = {
  post_id: string
  content: string
  created_at: string
  click_username?: string
  avatar_url?: string
  user_code?: string
  media_urls?: string[]
}

export default function ThreadPage() {
  const params = useParams()
  const threadId = Array.isArray(params?.threadId)
    ? params.threadId[0]
    : (params?.threadId as string)

  const { username, avatarUrl } = useAuth() // ← ここから取得
  const [posts, setPosts] = useState<Post[]>([])
  const [newComment, setNewComment] = useState('')
  const [loading, setLoading] = useState(true)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const fetchPosts = async () => {
    setErrMsg(null)
    try {
      const res = await fetch(`/api/thread-posts?threadId=${encodeURIComponent(threadId)}`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        const text = await res.text()
        setErrMsg(`取得に失敗しました (${res.status})`)
        console.error('[ThreadPage] fetch failed:', res.status, text)
        return
      }
      const data = await res.json()
      if (!Array.isArray(data)) {
        setErrMsg('データ形式が不正です')
        console.error('[ThreadPage] data is not array:', data)
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
    if (!threadId) return
    setLoading(true)
    fetchPosts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  const handlePost = async () => {
    if (!newComment.trim()) return
    try {
      const res = await fetch('/api/create-thread-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thread_id: threadId,
          content: newComment.trim(),
          click_username: username ?? '匿名',
          avatar_url: avatarUrl ?? null,
          // user_code は不要（DBが必須なら AuthContext から渡してください）
          board_type: 'self',
        }),
      })

      if (!res.ok) {
        const text = await res.text()
        alert(`送信に失敗しました: ${text}`)
        console.error('[ThreadPage] post failed', res.status, text)
        return
      }

      const created: Post = await res.json()
      setNewComment('')
      setPosts((prev) => (Array.isArray(prev) ? [...prev, created] : [created]))
    } catch (e) {
      console.error('[ThreadPage] post exception', e)
      alert('送信時にエラーが発生しました。')
    }
  }

  // スクロールを常に最新へ
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [posts])

  const parent = posts[0]

  return (
    <div className="thread-container">
      {/* 親つぶやき固定ヘッダー */}
      {parent && (
        <div className="fixed-header">
          {parent.avatar_url && <img src={parent.avatar_url} alt="avatar" className="avatar" />}
          <div className="header-info">
            <strong>{parent.click_username || parent.user_code || 'unknown'}</strong>
            <p>{parent.content}</p>
            <small>{new Date(parent.created_at).toLocaleString('ja-JP')}</small>
          </div>
        </div>
      )}

      {loading && <div className="meta">読み込み中...</div>}
      {errMsg && <div className="meta" style={{ color: '#ff9aa2' }}>{errMsg}</div>}

      <div className="thread-posts" ref={listRef}>
        {posts.slice(1).map((post) => (
          <div key={post.post_id} className="post">
            <div className="meta">
              {post.click_username || post.user_code || 'unknown'} |{' '}
              {new Date(post.created_at).toLocaleString('ja-JP')}
            </div>
            <div className="content">{post.content}</div>
          </div>
        ))}
      </div>

      <div className="post-form">
        <textarea
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          placeholder="コメントを入力..."
        />
        <button onClick={handlePost}>送信</button>
      </div>
    </div>
  )
}
