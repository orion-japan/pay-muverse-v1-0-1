'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import SelfPostModal from '@/components/SelfPostModal';
import './self.css';

type Post = {
  post_id: string;
  title?: string;
  content?: string;
  tags?: string[];
  media_urls: string[];
  created_at: string;
  board_type?: string | null;

  // 投稿者情報（API側で付与）
  click_username?: string | null;
  user_code?: string | null;
  profiles?: {
    name?: string;
    avatar_url?: string | null; // 署名URLを作る元パス。実表示は /api/avatar/[userCode] 推奨
  };
};

type ThreadStat = {
  post_id: string;
  reply_count?: number | null;
  last_commented_at?: string | null;
  has_ai?: boolean | null;
};

const BOARD_TYPE = 'self';
const DEFAULT_AVATAR = '/iavatar_default.png';

export default function SelfPage() {
  const { userCode } = useAuth();
  const router = useRouter();

  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [statsMap, setStatsMap] = useState<Record<string, ThreadStat>>({});

  const fetchSelfPosts = async (code: string) => {
    const url = `/api/self-posts?userCode=${encodeURIComponent(
      code
    )}&boardType=${encodeURIComponent(BOARD_TYPE)}`;
    console.log('[SelfPage] 📡 取得開始', { url, BOARD_TYPE });

    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('[SelfPage] ❌ API失敗', res.status, t);
      setPosts([]);
      return;
    }

    const data: Post[] = await res.json();
    console.log('[SelfPage] ✅ 取得成功（件数）', data?.length ?? 0);

    const filtered = Array.isArray(data)
      ? data.filter((p) => {
          const bt = (p as any)?.board_type;
          return bt == null || String(bt).toLowerCase() === BOARD_TYPE;
        })
      : [];

    setPosts(filtered);

    try {
      const ids = filtered.map((p) => p.post_id);
      if (!ids.length) {
        setStatsMap({});
        return;
      }
      const q = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&');
      const statRes = await fetch(`/api/thread-stats?${q}`, {
        cache: 'no-store',
      });
      if (statRes.ok) {
        const arr: ThreadStat[] = await statRes.json();
        const map: Record<string, ThreadStat> = {};
        arr.forEach((s) => (map[s.post_id] = s));
        setStatsMap(map);
      } else {
        setStatsMap({});
      }
    } catch {
      setStatsMap({});
    }
  };

  useEffect(() => {
    if (!userCode) return;
    setLoading(true);
    fetchSelfPosts(userCode).finally(() => setLoading(false));
  }, [userCode]);

  const openPostModal = () => setModalOpen(true);
  const closePostModal = () => setModalOpen(false);

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString('ja-JP', {
      dateStyle: 'short',
      timeStyle: 'short',
    });

  const ellipsis = (s: string, n = 120) =>
    s.length > n ? s.slice(0, n) + '…' : s;

  const avatarSrcOf = (uc?: string | null) =>
    uc ? `/api/avatar/${encodeURIComponent(uc)}` : DEFAULT_AVATAR;

  const looksAI = (p: Post) => {
    const st = statsMap[p.post_id];
    if (st?.has_ai) return true;
    if (p.tags?.some((t) => /ai|bot|assistant/i.test(t))) return true;
    if (/(?:\bAI\b|アシスタント|ボット)/i.test(p.content || '')) return true;
    return false;
  };

  // ===== DigestRow をここで定義 =====
  const DigestRow = ({ p }: { p: Post }) => {
    const author =
      p.profiles?.name ?? p.click_username ?? p.user_code ?? 'unknown';
    const firstLine = (p.content || '').trim();
    const snippet = firstLine ? ellipsis(firstLine, 60) : '（本文なし）';
    const replyCount = statsMap[p.post_id]?.reply_count ?? 0;
    const avatarUrl = avatarSrcOf(p.user_code);

    return (
      <div className="digest-row compact">
        {/* アイコン → Self一覧ページ */}
        <img
          className="avatar"
          src={avatarUrl}
          alt=""
          onClick={() => p.user_code && router.push(`/self/${p.user_code}`)}
          style={{ cursor: 'pointer' }}
        />

        <div className="oneline">
          {/* 名前 → プロフィールページ */}
          <strong
            className="author"
            onClick={() =>
              p.user_code && router.push(`/profile/${p.user_code}`)
            }
            style={{ cursor: 'pointer' }}
          >
            {author}
          </strong>

          <span className="dot">・</span>
          {/* 本文 → スレッドページ */}
          <span
            className="snippet"
            onClick={() => router.push(`/thread/${p.post_id}`)}
            style={{ cursor: 'pointer' }}
          >
            {snippet}
          </span>

          <span className="meta">{formatDate(p.created_at)}</span>
          {replyCount > 0 && <span className="pill">{replyCount}</span>}
          {looksAI(p) && <span className="pill ai">AI</span>}
        </div>
      </div>
    );
  };

  // ===== ソート済みリスト =====
  const recent = useMemo(
    () =>
      [...posts].sort(
        (a, b) => +new Date(b.created_at) - +new Date(a.created_at)
      ),
    [posts]
  );

  const active = useMemo(() => {
    const sortable = [...posts];
    sortable.sort((a, b) => {
      const ar = statsMap[a.post_id]?.reply_count ?? -1;
      const br = statsMap[b.post_id]?.reply_count ?? -1;
      if (ar !== br) return br - ar;
      const al = statsMap[a.post_id]?.last_commented_at
        ? +new Date(statsMap[a.post_id]!.last_commented_at!)
        : 0;
      const bl = statsMap[b.post_id]?.last_commented_at
        ? +new Date(statsMap[b.post_id]!.last_commented_at!)
        : 0;
      if (al !== bl) return bl - al;
      return +new Date(b.created_at) - +new Date(a.created_at);
    });
    return sortable;
  }, [posts, statsMap]);

  const aiList = useMemo(
    () =>
      posts
        .filter(looksAI)
        .sort(
          (a, b) => +new Date(b.created_at) - +new Date(a.created_at)
        ),
    [posts, statsMap]
  );

  // ===== レンダリング =====
  return (
    <div className="self-page">
      <h1>🧠 Self Talk</h1>

      {loading ? (
        <p>読み込み中...</p>
      ) : (
        <section className="digest-sections">
          {/* 最新 */}
          <div className="digest-section">
            <h2>⏱️ 最新のSelf Talk</h2>
            <div className="digest-list">
              {recent.slice(0, 20).map((p) => (
                <DigestRow key={`recent-${p.post_id}`} p={p} />
              ))}
              {!recent.length && (
                <p className="empty">まだ投稿がありません。</p>
              )}
            </div>
          </div>

          {/* 更新の多い */}
          <div className="digest-section">
            <h2>🔥 更新の多いSelf Talk</h2>
            <div className="digest-list">
              {(active.length ? active : recent).slice(0, 20).map((p) => (
                <DigestRow key={`active-${p.post_id}`} p={p} />
              ))}
              {!active.length && !!recent.length && (
                <p className="hint">
                  統計が無いので最新順を表示しています。
                </p>
              )}
            </div>
          </div>

          {/* AI参加 */}
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

      {/* 新規スレッド作成 */}
      <button className="floating-button attn" aria-label="セルフトークを投稿">
        +S
      </button>

      <SelfPostModal
        isOpen={modalOpen}
        onClose={closePostModal}
        userCode={userCode || ''}
        boardType={BOARD_TYPE}
        onPostSuccess={() => {
          console.log('[SelfPage] 🔄 投稿後の再取得トリガ');
          if (!userCode) return;
          setLoading(true);
          fetchSelfPosts(userCode).finally(() => setLoading(false));
        }}
      />
    </div>
  );
}
