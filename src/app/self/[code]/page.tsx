'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import ReactionBar from '@/components/ReactionBar';
import QCodeBadge from '@/components/QCodeBadge'; // 使わないなら削除OK
import './self.css';

type Profile = {
  user_code: string;
  name: string;
  avatar_url?: string | null;
};

type Post = {
  post_id: string;
  title?: string | null;
  content?: string | null;
  created_at: string;
  board_type?: string | null;
  user_code?: string | null;
};

type ReactionCount = { r_type: string; count: number };

const BOARD_TYPE = 'self';
const DEFAULT_AVATAR = '/iavatar_default.png';

export default function SelfPage() {
  const params = useParams();
  const router = useRouter();
  const { userCode: viewerUserCode } = useAuth(); // 押す人（閲覧者）

  // /self/[code] の [code]
  const code: string | null = useMemo(() => {
    const raw = params?.code as string | string[] | undefined;
    if (!raw) return null;
    return Array.isArray(raw) ? raw[0] : raw;
  }, [params]);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [countsMap, setCountsMap] = useState<Record<string, ReactionCount[]>>({});
  const [loading, setLoading] = useState(true);

  // 直近のイベント重複反映ガード
  const seen = useRef<Set<string>>(new Set());

  const toArray = (v: any): any[] =>
    Array.isArray(v) ? v :
    Array.isArray(v?.data) ? v.data :
    Array.isArray(v?.items) ? v.items :
    Array.isArray(v?.rows) ? v.rows : [];

  // プロフィール取得
  useEffect(() => {
    if (!code) return;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/get-profile?code=${encodeURIComponent(code)}`, {
          signal: ac.signal,
          cache: 'no-store',
        });
        if (!res.ok) return;
        const json = await res.json();
        const p: Profile | null = json?.profile ?? (json?.user_code ? json : null);
        if (!ac.signal.aborted && p) setProfile(p);
      } catch (e: any) {
        if (e?.name !== 'AbortError') console.error('[Self/[code]] get-profile error:', e);
      }
    })();
    return () => ac.abort();
  }, [code]);

  // 初期取得（本人の self 投稿だけ）＋ 共鳴カウント
  useEffect(() => {
    if (!code) return;
    const ac = new AbortController();
    let mounted = true;
    setLoading(true);

    (async () => {
      try {
        const url = `/api/self-posts?userCode=${encodeURIComponent(code)}&boardType=${BOARD_TYPE}`;
        const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
        if (!res.ok) return;
        const list: Post[] = toArray(await res.json());

        if (mounted && !ac.signal.aborted) {
          // board_type=self かつ user_code がこの code のものだけ
          const onlyThisUser = list.filter(
            (p) =>
              (p.user_code === code) &&
              (!p.board_type || String(p.board_type).toLowerCase() === BOARD_TYPE)
          );
          setPosts(onlyThisUser);

          // 共鳴カウントまとめて取得
          const ids = onlyThisUser.map((p) => p.post_id);
          if (ids.length) {
            try {
              const resCnt = await fetch('/api/reactions/counts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ postIds: ids }),
              });
              if (resCnt.ok) {
                const { countsByPost } = await resCnt.json();
                if (mounted && !ac.signal.aborted) {
                  setCountsMap(countsByPost || {});
                }
              } else {
                setCountsMap({});
              }
            } catch {
              setCountsMap({});
            }
          } else {
            setCountsMap({});
          }
        }
      } catch (e: any) {
        if (e?.name !== 'AbortError') console.error('[Self/[code]] self-posts error:', e);
      } finally {
        if (mounted && !ac.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
      ac.abort();
    };
  }, [code]);

  // Realtime 購読（本人の self のみ）
  useEffect(() => {
    if (!code) return;

    const upsert = (row: any) => {
      if (row?.user_code !== code) return;
      if (row?.board_type && String(row.board_type).toLowerCase() !== BOARD_TYPE) return;

      const k = `${row.post_id}:${row.updated_at ?? row.created_at ?? ''}`;
      if (k && seen.current.has(k)) return;
      if (k) {
        seen.current.add(k);
        if (seen.current.size > 500) seen.current.clear();
      }

      setPosts((prev) => {
        const idx = prev.findIndex((p) => p.post_id === row.post_id);
        if (idx === -1) {
          const next = [{ ...row }, ...prev].sort(
            (a, b) => +new Date(b.created_at) - +new Date(a.created_at)
          );
          // 新規分のカウント再取得（簡便に全体）
          refetchCounts(next);
          return next;
        }
        const next = [...prev];
        next[idx] = { ...next[idx], ...row };
        return next;
      });
    };

    const remove = (row: any) => {
      if (row?.user_code !== code) return;
      setPosts((prev) => {
        const next = prev.filter((p) => p.post_id !== row.post_id);
        setCountsMap((m) => {
          const { [row.post_id]: _, ...rest } = m;
          return rest;
        });
        return next;
      });
    };

    const channel = supabase
      .channel(`posts:self:${code}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'posts', filter: `user_code=eq.${code}` },
        (payload) => {
          if (payload.eventType === 'DELETE') remove(payload.old);
          else upsert(payload.new);
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') console.log('[Self/[code]] 🔔 Realtime subscribed');
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [code]);

  // 共鳴カウント再取得
  const refetchCounts = async (list = posts) => {
    try {
      const ids = list.map((p) => p.post_id);
      if (!ids.length) {
        setCountsMap({});
        return;
      }
      const res = await fetch('/api/reactions/counts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postIds: ids }),
      });
      if (!res.ok) {
        setCountsMap({});
        return;
      }
      const { countsByPost } = await res.json();
      setCountsMap(countsByPost || {});
    } catch {
      setCountsMap({});
    }
  };

  // code が無いアクセスはホームへ
  useEffect(() => {
    if (code === null) router.replace('/');
  }, [code, router]);

  // アバター：空や相対パスでも確実に既定へ
  const avatarSrcOf = (p?: Profile | null) => {
    const raw = (p?.avatar_url || '').trim();
    if (!raw) return DEFAULT_AVATAR;
    return raw.startsWith('/') ? raw : `/${raw}`;
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });

  return (
    <div className="self-page">
      {/* ← 戻る（thread と同じ上部配置） */}
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => {
            if (window.history.length > 1) router.back();
            else router.push('/self');
          }}
          aria-label="戻る"
          style={{
            padding: '6px 12px',
            borderRadius: 8,
            border: '1px solid #ccc',
            background: '#fff',
            cursor: 'pointer',
          }}
        >
          ← 戻る
        </button>
      </div>

      {profile && (
        <div
          className="user-header"
          onClick={() => router.push(`/profile/${profile.user_code}`)}
          style={{
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            marginBottom: '20px',
            flexWrap: 'wrap',
          }}
        >
          <img
            src={avatarSrcOf(profile)}
            alt="avatar"
            width={60}
            height={60}
            style={{ borderRadius: '50%' }}
            onError={(e) => {
              const img = e.currentTarget;
              if (img.src !== window.location.origin + DEFAULT_AVATAR) {
                img.src = DEFAULT_AVATAR; // 404 等でも既定にフォールバック
              }
            }}
          />
          <div>
            <h2 style={{ margin: 0 }}>{profile.name}</h2>
            <p style={{ fontSize: '0.9em', color: '#666', margin: 0 }}>👉 プロフィールを見る</p>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <QCodeBadge userCode={profile.user_code} />
          </div>
        </div>
      )}

      <h3>🧠 Self 投稿一覧</h3>

      {loading ? (
        <p>読み込み中...</p>
      ) : posts.length === 0 ? (
        <p>まだ投稿がありません</p>
      ) : (
        <ul className="self-list">
          {posts.map((p) => (
            <li key={p.post_id} className="self-item">
              <div className="self-item-title">
                <strong>{p.title ?? '(本文なし)'}</strong>
              </div>
              {p.content && <p className="self-item-content">{p.content}</p>}
              <small className="date">{formatDate(p.created_at)}</small>

              {/* 共鳴バー（ボタン＋数、押せる） */}
              <div className="actions-row" style={{ marginTop: 8 }}>
                <ReactionBar
                  postId={p.post_id}
                  userCode={viewerUserCode || ''}          // 押す人（閲覧者）
                  initialCounts={countsMap[p.post_id] || []}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
