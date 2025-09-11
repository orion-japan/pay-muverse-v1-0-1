'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/context/AuthContext'
import SelfPostModal from '@/components/SelfPostModal'
import ReactionBar from '@/components/ReactionBar'
import { formatJST } from '@/lib/formatDate' // ★ 追加：JST統一フォーマッタ
import './self.css'

const DEBUG = false
const dlog = (...a: any[]) => DEBUG && console.log(...a)

/* ==== 型 ==== */
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
  profiles?: { name?: string | null; avatar_url?: string | null }
}

type ThreadStat = {
  post_id: string
  reply_count?: number | null
  last_commented_at?: string | null
  has_ai?: boolean | null
}

type ReactionCount = { r_type: string; count: number }

/* ==== 定数 ==== */
const BOARD_TYPE = 'self'
const DEFAULT_AVATAR = '/iavatar_default.png'

/* ==== かんたんトースト ==== */
function Toasts({
  items,
  onClose,
}: {
  items: Array<{ id: string; title?: string | null; body?: string | null; url?: string | null }>
  onClose: (id: string) => void
}) {
  if (!items.length) return null
  return (
    <div className="self-toasts">
      {items.slice(-3).map((n) => (
        <div
          key={n.id}
          onClick={() => {
            if (n.url) location.assign(n.url)
          }}
          className="self-toast"
        >
          <div className="ttl">{n.title || '通知'}</div>
          {n.body && <div className="body">{n.body}</div>}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onClose(n.id)
            }}
            aria-label="閉じる"
            className="okbtn"
          >
            OK
          </button>
        </div>
      ))}
    </div>
  )
}

/* ==== ページ本体 ==== */
export default function SelfPage() {
  const { userCode } = useAuth()
  const router = useRouter()

  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [statsMap, setStatsMap] = useState<Record<string, ThreadStat>>({})
  const [countsMap, setCountsMap] = useState<Record<string, ReactionCount[]>>({})
  const [toasts, setToasts] = useState<
    Array<{ id: string; title?: string | null; body?: string | null; url?: string | null }>
  >([])

  // counts 連打抑止
  const countsErrorUntilRef = useRef<number>(0)
  const countsRefreshQueue = useRef<Set<string>>(new Set())
  const countsRefreshTimer = useRef<any>(null)

  const toArray = (v: any): any[] =>
    Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : Array.isArray(v?.items) ? v.items : Array.isArray(v?.rows) ? v.rows : []

  const avatarSrcOf = (uc?: string | null) => (uc ? `/api/avatar/${encodeURIComponent(uc)}` : DEFAULT_AVATAR)

  type CountsLike = Partial<{ like: number; heart: number; smile: number; wow: number; share: number }>
  const toCounts = (arr?: ReactionCount[] | null): CountsLike => {
    const out: CountsLike = {}
    if (!arr) return out
    const allow = new Set(['like', 'heart', 'smile', 'wow', 'share'])
    for (const a of arr) {
      const k = String(a?.r_type || '').toLowerCase()
      if (allow.has(k)) (out as any)[k] = a?.count ?? 0
    }
    return out
  }

  /* ==== 反応カウント（バッチ） ==== */
  const fetchCountsBatch = async (postIds: string[]) => {
    if (!postIds.length) {
      setCountsMap({})
      return
    }
    const now = Date.now()
    if (now < countsErrorUntilRef.current) return

    try {
      const res = await fetch('/api/reactions/counts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_ids: postIds }),
      })
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(t || `HTTP ${res.status}`)
      }
      const json = await res.json()
      const countsObj = (json && json.counts) || {}

      const next: Record<string, ReactionCount[]> = {}
      for (const pid of postIds) {
        const entry = countsObj[pid] || {}
        next[pid] = Object.entries(entry).map(([r_type, count]) => ({ r_type, count: (count as number) ?? 0 }))
      }
      setCountsMap((prev) => ({ ...prev, ...next }))
    } catch (e) {
      console.warn('[SelfPage] counts batch error', e)
      countsErrorUntilRef.current = now + 20_000
    }
  }

  /* ==== 一覧取得 ==== */
  const fetchSelfPosts = async (code: string) => {
    const url = `/api/self-posts?userCode=${encodeURIComponent(code)}&boardType=${encodeURIComponent(BOARD_TYPE)}`
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      console.error('[SelfPage] ❌ fetch failed', res.status, t)
      setPosts([])
      setStatsMap({})
      setCountsMap({})
      return
    }

    const json = await res.json()
    const data: Post[] = toArray(json)

    const filtered = data.filter((p) => {
      const bt = (p as any)?.board_type
      return bt == null || String(bt).toLowerCase() === BOARD_TYPE
    })

    setPosts(filtered)

    // 統計
    try {
      const ids = filtered.map((p) => p.post_id)
      if (!ids.length) {
        setStatsMap({})
      } else {
        const q = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&')
        const statRes = await fetch(`/api/thread-stats?${q}`, { cache: 'no-store' })
        if (!statRes.ok) {
          const t = await statRes.text().catch(() => '')
          console.warn('[SelfPage] stats fetch failed', statRes.status, t)
          setStatsMap({})
        } else {
          const arr = toArray(await statRes.json())
          const map: Record<string, ThreadStat> = {}
          for (const s of arr) if (s?.post_id) map[s.post_id] = s
          setStatsMap(map)
        }
      }
    } catch (e) {
      console.warn('[SelfPage] stats error', e)
      setStatsMap({})
    }

    await fetchCountsBatch(filtered.map((p) => p.post_id))
  }

  const enqueueCountsRefresh = (postId: string) => {
    countsRefreshQueue.current.add(postId)
    if (countsRefreshTimer.current) return
    countsRefreshTimer.current = setTimeout(async () => {
      const ids = [...countsRefreshQueue.current]
      countsRefreshQueue.current.clear()
      countsRefreshTimer.current = null
      await fetchCountsBatch(ids)
    }, 500)
  }

  useEffect(() => {
    if (!userCode) {
      setLoading(false)
      return
    }
    setLoading(true)
    fetchSelfPosts(userCode).finally(() => setLoading(false))
  }, [userCode])

  useEffect(() => {
    if (!userCode) return

    const upsert = (row: any) => {
      if (row?.board_type && String(row.board_type).toLowerCase() !== 'self') return
      setPosts((prev) => {
        const idx = prev.findIndex((p) => p.post_id === row.post_id)
        if (idx === -1) {
          const next = [{ ...row }, ...prev].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
          fetchCountsBatch([row.post_id])
          return next
        }
        const next = [...prev]
        next[idx] = { ...next[idx], ...row }
        return next
      })
    }

    const remove = (row: any) => {
      setPosts((prev) => prev.filter((p) => p.post_id !== row.post_id))
      setCountsMap((m) => {
        const { [row.post_id]: _, ...rest } = m
        return rest
      })
    }

    const ch = supabase
      .channel(`posts:self:${userCode}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts', filter: `user_code=eq.${userCode}` }, (p) =>
        upsert(p.new)
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts', filter: `user_code=eq.${userCode}` }, (p) =>
        upsert(p.new)
      )
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts', filter: `user_code=eq.${userCode}` }, (p) =>
        remove(p.old)
      )
      .subscribe()

    return () => {
      supabase.removeChannel(ch)
    }
  }, [userCode])

  useEffect(() => {
    if (!userCode) return
    const ch = supabase
      .channel(`reactions:self:${userCode}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'post_reactions' }, (payload) => {
        const row = (payload.new || payload.old) as any
        if (row?.post_id) enqueueCountsRefresh(row.post_id)
      })
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [userCode])

  /* ===== UI ヘルパ ===== */
  const formatDate = (iso: string) => formatJST(iso) // ★ 置き換え：JST固定・YYYY/MM/DD HH:mm
  const ellipsis = (s: string, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s)
  const looksAI = (p: Post) => {
    const st = statsMap[p.post_id]
    if (st?.has_ai) return true
    if (p.tags?.some((t) => /ai|bot|assistant/i.test(t))) return true
    if (/(?:\bAI\b|アシスタント|ボット)/i.test(p.content || '')) return true
    return false
  }

// 置き換え：DigestRow
const DigestRow = ({ p }: { p: Post }) => {
  const author = p.profiles?.name ?? p.click_username ?? p.user_code ?? 'unknown'
  const snippet = (p.content || '').trim()
  const replyCount = statsMap[p.post_id]?.reply_count ?? 0
  const avatarUrl = avatarSrcOf(p.user_code)

  const goDetail = () => router.push(`/thread/${p.post_id}`)

  return (
    <div
      className="digest-row compact"
      role="link"
      tabIndex={0}
      onClick={goDetail}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          goDetail()
        }
      }}
      title={snippet}
    >
      {/* 左の丸アイコン（→ プロフィールへ、親クリックは止める） */}
      <img
        className="avatar"
        src={avatarUrl}
        alt=""
        onClick={(e) => {
          e.stopPropagation()
          if (p.user_code) router.push(`/self/${p.user_code}`)
        }}
        onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_AVATAR }}
        style={{ cursor: 'pointer' }}
      />

      {/* 1行目：作者（左）／日付（右） */}
      <div className="row head">
        <strong
          className="author"
          onClick={(e) => {
            e.stopPropagation()
            if (p.user_code) router.push(`/profile/${p.user_code}`)
          }}
          style={{ cursor: 'pointer' }}
        >
          {author}
        </strong>
        <span className="meta">{formatDate(p.created_at)}</span>
      </div>

      {/* 2行目：本文（左）／返信数ピル等（右） */}
      <div className="row body">
        <span className="snippet">{snippet || '（本文なし）'}</span>
        <div className="tail-right">
          {replyCount > 0 && <span className="pill">{replyCount}</span>}
          {looksAI(p) && <span className="pill ai">AI</span>}
        </div>
      </div>

      {/* 3行目：リアクション（→ 親クリックは止める） */}
      <div
        className="reaction-row"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <ReactionBar
          postId={p.post_id}
          userCode={userCode || ''}
          isParent={true}
          initialCounts={toCounts(countsMap[p.post_id])}
          readOnly={true}
        />
      </div>
    </div>
  )
}

  const recent = useMemo(() => [...posts].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)), [posts])

  const active = useMemo(() => {
    const s = [...posts]
    s.sort((a, b) => {
      const ar = statsMap[a.post_id]?.reply_count ?? -1
      const br = statsMap[b.post_id]?.reply_count ?? -1
      if (ar !== br) return br - ar
      const al = statsMap[a.post_id]?.last_commented_at ? +new Date(statsMap[a.post_id]!.last_commented_at!) : 0
      const bl = statsMap[b.post_id]?.last_commented_at ? +new Date(statsMap[b.post_id]!.last_commented_at!) : 0
      if (al !== bl) return bl - al
      return +new Date(b.created_at) - +new Date(a.created_at)
    })
    return s
  }, [posts, statsMap])

  const aiList = useMemo(() => posts.filter(looksAI).sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)), [posts, statsMap])

  return (
    // ★ self-shell で周辺スタイルを遮断
    <div className="self-shell">
      <div className="self-page">
        <h1> Self Talk</h1>

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
                {!active.length && !!recent.length && <p className="hint">統計が無いので最新順を表示しています。</p>}
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

        <button type="button" className="floating-button attn" onClick={() => setModalOpen(true)} aria-label="セルフトークを投稿">
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

        <Toasts items={toasts} onClose={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />
      </div>
    </div>
  )
}
