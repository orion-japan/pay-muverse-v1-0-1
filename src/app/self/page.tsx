'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/context/AuthContext'
import SelfPostModal from '@/components/SelfPostModal'
import './self.css'

type Post = {
  post_id: string
  title?: string | null
  content?: string | null
  tags?: string[] | null
  media_urls: string[]
  created_at: string
  board_type?: string | null
  click_username?: string | null
  user_code?: string | null
  profiles?: {
    name?: string | null
    avatar_url?: string | null
  }
}

type ThreadStat = {
  post_id: string
  reply_count?: number | null
  last_commented_at?: string | null
  has_ai?: boolean | null
}

const BOARD_TYPE = 'self'
const DEFAULT_AVATAR = '/iavatar_default.png'

export default function SelfPage() {
  const { userCode } = useAuth()
  const router = useRouter()

  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [statsMap, setStatsMap] = useState<Record<string, ThreadStat>>({})

  /** 配列に正規化するヘルパ */
  const toArray = (v: any): any[] =>
    Array.isArray(v) ? v :
    Array.isArray(v?.data) ? v.data :
    Array.isArray(v?.items) ? v.items :
    Array.isArray(v?.rows) ? v.rows : []

  /** 一覧取得 */
  const fetchSelfPosts = async (code: string) => {
    const url = `/api/self-posts?userCode=${encodeURIComponent(
      code
    )}&boardType=${encodeURIComponent(BOARD_TYPE)}`
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      console.error('[SelfPage] ❌ fetch failed', res.status, t)
      setPosts([])
      setStatsMap({})
      return
    }

    const json = await res.json()
    const data: Post[] = toArray(json)

    const filtered = data.filter((p) => {
      const bt = (p as any)?.board_type
      return bt == null || String(bt).toLowerCase() === BOARD_TYPE
    })

    setPosts(filtered)

    try {
      const ids = filtered.map((p) => p.post_id)
      if (!ids.length) {
        setStatsMap({})
        return
      }
      const q = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&')
      const statRes = await fetch(`/api/thread-stats?${q}`, { cache: 'no-store' })
      if (!statRes.ok) {
        const t = await statRes.text().catch(() => '')
        console.warn('[SelfPage] stats fetch failed', statRes.status, t)
        setStatsMap({})
        return
      }
      const arr = toArray(await statRes.json())
      const map: Record<string, ThreadStat> = {}
      for (const s of arr) {
        if (s?.post_id) map[s.post_id] = s
      }
      setStatsMap(map)
    } catch (e) {
      console.warn('[SelfPage] stats error', e)
      setStatsMap({})
    }
  }

  /** 初期取得 */
  useEffect(() => {
    if (!userCode) {
      setLoading(false)
      return
    }
    setLoading(true)
    fetchSelfPosts(userCode).finally(() => setLoading(false))
  }, [userCode])

  /** Realtime購読 */
  useEffect(() => {
    if (!userCode) return

    const upsert = (row: any) => {
      if (row?.board_type && String(row.board_type).toLowerCase() !== 'self') return

      setPosts((prev) => {
        const idx = prev.findIndex((p) => p.post_id === row.post_id)
        if (idx === -1) {
          return [{ ...row }, ...prev].sort(
            (a, b) => +new Date(b.created_at) - +new Date(a.created_at)
          )
        }
        const next = [...prev]
        next[idx] = { ...next[idx], ...row }
        return next
      })
    }

    const remove = (row: any) => {
      setPosts((prev) => prev.filter((p) => p.post_id !== row.post_id))
    }

    const channel = supabase
      .channel(`posts:self:${userCode}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'posts', filter: `user_code=eq.${userCode}` },
        (payload) => upsert(payload.new)
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'posts', filter: `user_code=eq.${userCode}` },
        (payload) => upsert(payload.new)
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'posts', filter: `user_code=eq.${userCode}` },
        (payload) => remove(payload.old)
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[SelfPage] 🔔 Realtime subscribed')
        }
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [userCode])

  // ===== UIヘルパ =====
  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })

  const ellipsis = (s: string, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s)

  const avatarSrcOf = (uc?: string | null) =>
    uc ? `/api/avatar/${encodeURIComponent(uc)}` : DEFAULT_AVATAR

  const looksAI = (p: Post) => {
    const st = statsMap[p.post_id]
    if (st?.has_ai) return true
    if (p.tags?.some((t) => /ai|bot|assistant/i.test(t))) return true
    if (/(?:\bAI\b|アシスタント|ボット)/i.test(p.content || '')) return true
    return false
  }

  const DigestRow = ({ p }: { p: Post }) => {
    const author = p.profiles?.name ?? p.click_username ?? p.user_code ?? 'unknown'
    const snippet = (p.content || '').trim()
    const replyCount = statsMap[p.post_id]?.reply_count ?? 0
    const avatarUrl = avatarSrcOf(p.user_code)

    return (
      <div className="digest-row compact">
        <img
          className="avatar"
          src={avatarUrl}
          alt=""
          onClick={() => p.user_code && router.push(`/self/${p.user_code}`)}
          style={{ cursor: 'pointer' }}
        />
        <div className="oneline">
          <strong
            className="author"
            onClick={() => p.user_code && router.push(`/profile/${p.user_code}`)}
            style={{ cursor: 'pointer' }}
          >
            {author}
          </strong>
          <span className="dot">・</span>
          <span
            className="snippet"
            onClick={() => router.push(`/thread/${p.post_id}`)}
            style={{ cursor: 'pointer' }}
          >
            {ellipsis(snippet, 60) || '（本文なし）'}
          </span>
          <span className="meta">{formatDate(p.created_at)}</span>
          {replyCount > 0 && <span className="pill">{replyCount}</span>}
          {looksAI(p) && <span className="pill ai">AI</span>}
        </div>
      </div>
    )
  }

  const recent = useMemo(
    () => [...posts].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)),
    [posts]
  )

  const active = useMemo(() => {
    const sortable = [...posts]
    sortable.sort((a, b) => {
      const ar = statsMap[a.post_id]?.reply_count ?? -1
      const br = statsMap[b.post_id]?.reply_count ?? -1
      if (ar !== br) return br - ar
      const al = statsMap[a.post_id]?.last_commented_at
        ? +new Date(statsMap[a.post_id]!.last_commented_at!)
        : 0
      const bl = statsMap[b.post_id]?.last_commented_at
        ? +new Date(statsMap[b.post_id]!.last_commented_at!)
        : 0
      if (al !== bl) return bl - al
      return +new Date(b.created_at) - +new Date(a.created_at)
    })
    return sortable
  }, [posts, statsMap])

  const aiList = useMemo(
    () => posts.filter(looksAI).sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)),
    [posts, statsMap]
  )

  return (
    <div className="self-page">
      <h1>🧠 Self Talk</h1>

      {loading ? (
        <p>読み込み中...</p>
      ) : (
        <section className="digest-sections">
          <div className="digest-section">
            <h2>⏱️ 最新のSelf Talk</h2>
            <div className="digest-list">
              {recent.slice(0, 20).map((p) => (
                <DigestRow key={`recent-${p.post_id}`} p={p} />
              ))}
              {!recent.length && <p className="empty">まだ投稿がありません。</p>}
            </div>
          </div>

          <div className="digest-section">
            <h2>🔥 更新の多いSelf Talk</h2>
            <div className="digest-list">
              {(active.length ? active : recent).slice(0, 20).map((p) => (
                <DigestRow key={`active-${p.post_id}`} p={p} />
              ))}
              {!active.length && !!recent.length && (
                <p className="hint">統計が無いので最新順を表示しています。</p>
              )}
            </div>
          </div>

          <div className="digest-section">
            <h2>🤖 AIが参加している</h2>
            <div className="digest-list">
              {aiList.slice(0, 20).map((p) => (
                <DigestRow key={`ai-${p.post_id}`} p={p} />
              ))}
              {!aiList.length && <p className="empty">対象なし。</p>}
            </div>
          </div>
        </section>
      )}

      <button
        type="button"
        className="floating-button attn"
        onClick={() => setModalOpen(true)}
        aria-label="セルフトークを投稿"
      >
        +S
      </button>

      <SelfPostModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        userCode={userCode || ''}
        boardType={BOARD_TYPE}
        onPostSuccess={() => {
          if (!userCode) return
          setLoading(true)
          fetchSelfPosts(userCode).finally(() => setLoading(false))
        }}
      />
    </div>
  )
}
