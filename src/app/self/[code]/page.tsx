'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
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
};

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
        if (!res.ok) {
          console.warn('[Self/[code]] get-profile status:', res.status);
          return;
        }
        const json = await res.json();
        // API が { profile: {...} } or 直返し のどちらでも拾う
        const p: Profile | null =
          json?.profile ?? (json?.user_code ? json : null);
        if (!ac.signal.aborted && p) setProfile(p);
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        console.error('[Self/[code]] get-profile error:', e);
      }
    })();

    return () => ac.abort();
  }, [code]);

  /** Self 投稿取得 */
  useEffect(() => {
    if (!code) return;
    const ac = new AbortController();
    let mounted = true;
    setLoading(true);

    (async () => {
      try {
        const url = `/api/self-posts?userCode=${encodeURIComponent(
          code
        )}&boardType=self`;
        const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
        if (!res.ok) {
          console.warn('[Self/[code]] self-posts status:', res.status);
          return;
        }
        const json = await res.json();
        // 期待フォーマット: { data: Post[] } に対応しつつ、配列直返しも許容
        const list: Post[] = Array.isArray(json) ? json : json?.data ?? [];
        if (mounted && !ac.signal.aborted) setPosts(list);
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        console.error('[Self/[code]] self-posts error:', e);
      } finally {
        if (mounted && !ac.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
      ac.abort();
    };
  }, [code]);

  // code が取れないケースはホームへ退避（直接アクセスの変形防止）
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
            <p style={{ fontSize: '0.9em', color: '#666', margin: 0 }}>
              👉 プロフィールを見る
            </p>
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
              <small className="date">
                {new Date(p.created_at).toLocaleString()}
              </small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
