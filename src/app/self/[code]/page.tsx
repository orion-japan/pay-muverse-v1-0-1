'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase'; // ★ anonキーのクライアント
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
};

const BOARD_TYPE = 'self';

export default function SelfPage() {
  const params = useParams();
  const router = useRouter();

  // /self/[code] の code を安全に文字列化
  const code: string | null = useMemo(() => {
    const raw = params?.code as string | string[] | undefined;
    if (!raw) return null;
    return Array.isArray(raw) ? raw[0] : raw;
  }, [params]);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  // 直近のイベント重複反映を抑制（post_id:timestamp などでキー化）
  const seen = useRef<Set<string>>(new Set());

  /** プロフィール取得 */
  useEffect(() => {
    if (!code) return;
    const ac = new AbortController();

    (async () => {
      try {
        const res = await fetch(
          `/api/get-profile?code=${encodeURIComponent(code)}`,
          { signal: ac.signal, cache: 'no-store' }
        );
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

  /** 初期の Self 投稿取得 */
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
        const json = await res.json();
        const list: Post[] = Array.isArray(json) ? json : json?.data ?? [];
        if (mounted && !ac.signal.aborted) {
          // board_type=self のみ（null を含めるなら条件を調整）
          const filtered = list.filter(
            (p) => !p.board_type || String(p.board_type).toLowerCase() === BOARD_TYPE
          );
          setPosts(filtered);
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

  /** ✅ Realtime 購読（INSERT/UPDATE/DELETE で即時反映） */
  useEffect(() => {
    if (!code) return;

    const upsert = (row: any) => {
      // 自分のページ & self 以外は無視
      if (row?.user_code !== code) return;
      if (row?.board_type && String(row.board_type).toLowerCase() !== BOARD_TYPE) return;

      // 重複ガード（post_id + updated_at/created_at）
      const k = `${row.post_id}:${row.updated_at ?? row.created_at ?? ''}`;
      if (k && seen.current.has(k)) return;
      if (k) {
        seen.current.add(k);
        if (seen.current.size > 500) seen.current.clear();
      }

      setPosts((prev) => {
        const idx = prev.findIndex((p) => p.post_id === row.post_id);
        if (idx === -1) {
          return [{ ...row }, ...prev].sort(
            (a, b) => +new Date(b.created_at) - +new Date(a.created_at)
          );
        }
        const next = [...prev];
        next[idx] = { ...next[idx], ...row };
        return next;
      });
    };

    const remove = (row: any) => {
      if (row?.user_code !== code) return;
      setPosts((prev) => prev.filter((p) => p.post_id !== row.post_id));
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

  // code が無いアクセスはホームへ
  useEffect(() => {
    if (code === null) router.replace('/');
  }, [code, router]);

  return (
    <div className="self-page">
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
          }}
        >
          <img
            src={profile.avatar_url || '/default.png'}
            alt="avatar"
            width={60}
            height={60}
            style={{ borderRadius: '50%' }}
          />
          <div>
            <h2 style={{ margin: 0 }}>{profile.name}</h2>
            <p style={{ fontSize: '0.9em', color: '#666', margin: 0 }}>👉 プロフィールを見る</p>
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
              <small className="date">{new Date(p.created_at).toLocaleString()}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
