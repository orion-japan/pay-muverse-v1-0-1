'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import SelfPostModal from '@/components/SelfPostModal';
import './self.css';

type Post = {
  post_id: string;
  title?: string;              // 互換のため残す（使わない）
  content?: string;            // 一覧では本文①のみ使う
  tags?: string[];
  media_urls: string[];
  created_at: string;
  board_type?: string | null;

  // 投稿者情報（API側で付与）
  click_username?: string | null;
  user_code?: string | null;
  profiles?: {
    name?: string;
    avatar_url?: string | null;  // 署名URLを作る元パス。実表示は /api/avatar/[userCode] 推奨
  };
};

// 追加：スレッド統計（存在すれば活用。無ければ undefined）
type ThreadStat = {
  post_id: string;               // 親post_id（=thread_id）
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

  // 追加：統計のマップ（任意）
  const [statsMap, setStatsMap] = useState<Record<string, ThreadStat>>({});

  const fetchSelfPosts = async (code: string) => {
    const url = `/api/self-posts?userCode=${encodeURIComponent(code)}&boardType=${encodeURIComponent(
      BOARD_TYPE
    )}`;
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

    // ★ APIで boardType=self 済みだが、過去データで board_type=null を self とみなして残す
    const filtered = Array.isArray(data)
      ? data.filter((p) => {
          const bt = (p as any)?.board_type;
          return bt == null || String(bt).toLowerCase() === BOARD_TYPE;
        })
      : [];

    setPosts(filtered);

    // ついでに統計をまとめて取得（任意API：無ければ無視）
    try {
      const ids = filtered.map((p) => p.post_id);
      if (!ids.length) {
        setStatsMap({});
        return;
      }
      const q = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&');
      const statRes = await fetch(`/api/thread-stats?${q}`, { cache: 'no-store' });
      if (statRes.ok) {
        const arr: ThreadStat[] = await statRes.json();
        const map: Record<string, ThreadStat> = {};
        arr.forEach((s) => (map[s.post_id] = s));
        setStatsMap(map);
      } else {
        setStatsMap({});
      }
    } catch {
      // 統計APIが無い/失敗でも正常に続行
      setStatsMap({});
    }
  };

  useEffect(() => {
    if (!userCode) return;
    setLoading(true);
    fetchSelfPosts(userCode).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userCode]);

  const openPostModal = () => setModalOpen(true);
  const closePostModal = () => setModalOpen(false);

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });

  const ellipsis = (s: string, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s);

  // 追加：アバターURL（署名URLAPI優先）
  const avatarSrcOf = (uc?: string | null) =>
    uc ? `/api/avatar/${encodeURIComponent(uc)}` : DEFAULT_AVATAR;

  // 追加：AI参加の判定（統計 + タグ/本文）
  const looksAI = (p: Post) => {
    const st = statsMap[p.post_id];
    if (st?.has_ai) return true;
    if (p.tags?.some((t) => /ai|bot|assistant/i.test(t))) return true;
    if (/(?:\bAI\b|アシスタント|ボット)/i.test(p.content || '')) return true;
    return false;
    };

  // 追加：共鳴語（Resonant words）抽出（日本語2〜6文字/英語3〜10文字くらいをざっくり）
  const extractResonantWords = (text: string, max = 3): string[] => {
    const t = (text || '').toLowerCase();
    const words = [
      ...(t.match(/[A-Za-z][A-Za-z'-]{2,9}/g) || []),                      // 英単語 3–10
      ...(t.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]{2,6}/gu) || []), // 和語 2–6
    ];
    const freq: Record<string, number> = {};
    for (const w of words) {
      if (/^(the|and|you|for|with|that|this|are|was|were|have|has)$/.test(w)) continue;
      freq[w] = (freq[w] || 0) + 1;
    }
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([w]) => w);
  };

  // 3セクション用データ
  const recent = useMemo(
    () => [...posts].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)),
    [posts]
  );

  const active = useMemo(() => {
    // 統計があれば活用（reply_count > last_commented_at > created_at）
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
    () => posts.filter(looksAI).sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)),
    [posts, statsMap]
  );

  // 行コンポーネント（RSS風 1〜2行表示）
// 置き換え：DigestRow（この関数だけ差し替え）
const DigestRow = ({ p }: { p: Post }) => {
  const author = p.profiles?.name ?? p.click_username ?? p.user_code ?? 'unknown';
  const firstLine = (p.content || '').trim();
  const snippet = firstLine ? ellipsis(firstLine, 60) : '（本文なし）';
  const replyCount = statsMap[p.post_id]?.reply_count ?? 0;

  return (
    <button
      className="digest-row compact"
      onClick={() => router.push(`/thread/${p.post_id}`)}
      aria-label="スレッドへ"
    >
      <img className="avatar" src={avatarSrcOf(p.user_code)} alt="" />
      <div className="oneline">
        <strong className="author">{author}</strong>
        <span className="dot">・</span>
        <span className="snippet">{snippet}</span>
        <span className="meta">{formatDate(p.created_at)}</span>
        {replyCount > 0 && <span className="pill">{replyCount}</span>}
        {looksAI(p) && <span className="pill ai">AI</span>}
      </div>

      {/* 既存の2行目/共鳴語UIはコンパクト表示では非表示にするため残しておくがCSSで隠す */}
      <div className="texts" style={{ display: 'none' }} />
    </button>
  );
};


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
              {!recent.length && <p className="empty">まだ投稿がありません。</p>}
            </div>
          </div>

          {/* 更新の多い（統計が無い時は最近順フォールバック） */}
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

          {/* AI 参加 */}
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

      {/* 新規スレッド作成（親1件のみ作成） */}
      <button
  className="floating-button attn"
  aria-label="セルフトークを投稿"
>
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
