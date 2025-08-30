'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import './talk.css';

type Plan = 'free' | 'regular' | 'premium' | 'master' | 'admin';
type FriendLevel = 'F' | 'R' | 'C' | 'I';

type FriendItem = {
  user_code: string;
  name: string | null;
  avatar_url: string | null;
  level: FriendLevel;
  lastMessageAt?: string | null;
  lastMessageText?: string | null;
  unreadCount?: number;
};

const threadIdOf = (me: string, friend: string) => [me, friend].sort().join('__');

/** 見本方式に合わせたアバターURL解決 */
function resolveAvatarUrl(raw: string | null): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
  const u = (raw ?? '').trim();
  if (!u) return '/avatar.png';
  if (/^https?:\/\//i.test(u) || /^data:image\//i.test(u)) return u;
  if (u.startsWith('/storage/v1/object/public/')) return `${base}${u}`;
  if (u.startsWith('avatars/')) return `${base}/storage/v1/object/public/${u}`;
  return `${base}/storage/v1/object/public/avatars/${u}`;
}

async function fetchMutualFriends(myCode: string): Promise<FriendItem[]> {
  const { data, error } = await supabase.rpc('get_talk_friends_from_follows', {
    p_my_code: myCode,
  });
  if (error) {
    console.error('[Talk] get_talk_friends_from_follows error:', error);
    return [];
  }
  return (data ?? []).map((r: any) => ({
    user_code: r.friend_code as string,
    name: (r.name as string) ?? null,
    avatar_url: (r.avatar_url as string) ?? null,
    level: (r.level as FriendLevel) ?? 'F',
  }));
}

/** サーバーAPI経由で最新&未読メタを取得（RLSの影響を受けない） */
async function hydrateThreadsMeta(
  myCode: string,
  friends: FriendItem[],
): Promise<Record<string, Pick<FriendItem, 'lastMessageAt' | 'lastMessageText' | 'unreadCount'>>> {
  if (!friends.length) return {};
  const threadIds = friends.map((f) => threadIdOf(myCode, f.user_code));
  const res = await fetch('/api/talk/meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ myCode, threadIds }),
  });
  if (!res.ok) {
    console.warn('[Talk] meta api error:', await res.text());
    return {};
  }
  const { metaByThreadId } = (await res.json()) as {
    metaByThreadId: Record<string, { lastMessageAt: string | null; lastMessageText: string | null; unreadCount: number }>;
  };

  const out: Record<string, Pick<FriendItem, 'lastMessageAt' | 'lastMessageText' | 'unreadCount'>> = {};
  for (const f of friends) {
    const tid = threadIdOf(myCode, f.user_code);
    const m = metaByThreadId[tid] || {};
    out[f.user_code] = {
      lastMessageAt: (m as any).lastMessageAt ?? null,
      lastMessageText: (m as any).lastMessageText ?? null,
      unreadCount: Number((m as any).unreadCount ?? 0),
    };
  }
  return out;
}

async function logOpenFTalk(myCode: string, friendCode: string) {
  try {
    const { error } = await supabase.from('mu_logs').insert([
      {
        user_code: myCode,
        action: 'open_ttalk',
        target_code: friendCode,
        source: 'talk_list',
        created_at: new Date().toISOString(),
      },
    ]);
    if (error) console.warn('[Talk] logOpenFTalk insert error:', error.message);
  } catch (e) {
    console.warn('[Talk] logOpenFTalk failed:', e);
  }
}

export default function TalkPage() {
  const router = useRouter();
  const auth: any = useAuth();
  const userCode: string | null = auth?.userCode ?? null;
  const planStatus: Plan = (auth?.planStatus as Plan) ?? 'free';

  const [loading, setLoading] = useState(true);
  const [friends, setFriends] = useState<FriendItem[]>([]);
  const [q, setQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const blocked = planStatus === 'free';

  // 初回 & 更新ボタン共通
  const loadFriends = async () => {
    setLoading(true);
    try {
      if (!userCode) {
        setFriends([]);
        return;
      }
      const list = await fetchMutualFriends(userCode);
      const meta = await hydrateThreadsMeta(userCode, list);

      const enrichedList = list.map((f) => {
        const m = (meta as any)[f.user_code] || {};
        return {
          ...f,
          lastMessageAt: m.lastMessageAt ?? null,
          lastMessageText: m.lastMessageText ?? null,
          unreadCount: Number(m.unreadCount ?? 0),
        } as FriendItem;
      });

      // 並び順：最新メッセージが上 → 未読多い順 → 名前
      const sortedList = enrichedList.sort((a, b) => {
        const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
        const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
        if (tb !== ta) return tb - ta;
        const ua = Number(a.unreadCount ?? 0);
        const ub = Number(b.unreadCount ?? 0);
        if (ub !== ua) return ub - ua;
        return (a.name ?? '').localeCompare(b.name ?? '', 'ja');
      });

      setFriends(sortedList);
      setLastUpdated(new Date());
    } catch (e) {
      console.error('[Talk] fetch error:', e);
    } finally {
      setLoading(false);
    }
  };

  // 初回ロード
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!mounted) return;
      await loadFriends();
    })();
    return () => {
      mounted = false;
    };
  }, [userCode]); // userCode変化時に再読込

  // 更新ボタン
  const handleRefresh = async () => {
    setRefreshing(true);
    await loadFriends();
    setRefreshing(false);
  };

  // 受信・既読更新をリアルタイム反映（INSERT/UPDATE）
  useEffect(() => {
    if (!userCode) return;

    const onChange = (payload: any) => {
      const r = (payload?.new ?? {}) as {
        thread_id?: string;
        sender_code?: string;
        receiver_code?: string | null;
      };
      const tid = String(r.thread_id || '');
      if (
        tid &&
        (tid.includes(userCode) ||
          r.sender_code === userCode ||
          r.receiver_code === userCode)
      ) {
        handleRefresh();
      }
    };

    const channel = supabase
      .channel('talk-list')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chats' },
        onChange,
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'chats' },
        onChange,
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userCode]); // handleRefresh は同スコープ参照でOK

  const filtered = useMemo(() => {
    if (!q.trim()) return friends;
    const key = q.toLowerCase();
    return friends.filter(
      (f) =>
        f.user_code.toLowerCase().includes(key) ||
        (f.name ?? '').toLowerCase().includes(key),
    );
  }, [q, friends]);

  // 未読合計（ヘッダー表示）
  const totalUnread = useMemo(
    () => friends.reduce((sum, f) => sum + Number(f.unreadCount ?? 0), 0),
    [friends],
  );

  const goFTalk = async (friend: FriendItem) => {
    if (!userCode) return;
    await logOpenFTalk(userCode, friend.user_code);
    const threadId = threadIdOf(userCode, friend.user_code);
    router.push(`/talk/${threadId}`);
  };

  // 画像クリック → 投稿一覧
  const goPosts = (friend: FriendItem) => {
    router.push(`/album?user=${encodeURIComponent(friend.user_code)}`);
  };

  const goProfile = (friend: FriendItem) => {
    router.push(`/profile/${encodeURIComponent(friend.user_code)}`);
  };

  return (
    <div className="talk-shell">
      <header className="talk-header">
        <h1>Talk</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <p className="talk-note" style={{ margin: 0 }}>
            両想い（<b>F以上</b>）の友達だけが表示されます。
            {blocked && (
              <span className="talk-note-warn">
                {' '}
                <br />
                現在プラン: free（閲覧のみ・開始はアップグレード後に可能）
              </span>
            )}
          </p>
          {totalUnread > 0 && (
            <span className="unread-total" aria-label={`未読 ${totalUnread} 件`}>
              未読 {totalUnread > 999 ? '999+' : totalUnread} 件
            </span>
          )}
          {/* 更新ボタンと最終更新 */}
          <button
            className="refresh-btn"
            onClick={handleRefresh}
            disabled={loading || refreshing}
            title="未読・一覧を更新"
          >
            {refreshing || loading ? '更新中…' : '更新'}
          </button>
          {lastUpdated && (
            <span className="updated-at" title={lastUpdated.toLocaleString()}>
              {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="talk-toolbar">
          <input
            className="talk-search"
            placeholder="友達を検索（名前 / ユーザーコード）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {blocked && (
            <button className="upgrade-btn" onClick={() => router.push('/pay')}>
              プランをアップグレード
            </button>
          )}
        </div>
      </header>

      {loading ? (
        <div className="talk-loading">読み込み中...</div>
      ) : filtered.length === 0 ? (
        <div className="talk-empty">
          現在、両想いが <b>S</b> 止まり、または相互フォローになっていません。<br />
          <b>TTalk は Regular（F）以上</b> の関係から利用できます。
        </div>
      ) : (
        <ul className="friend-list">
          {filtered.map((f) => (
            <li key={f.user_code} className="friend-item">
              <img
                className="friend-avatar"
                src={resolveAvatarUrl(f.avatar_url)}
                alt={f.name || f.user_code}
                width={48}
                height={48}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                onClick={() => goPosts(f)}
                onError={(e) => {
                  const el = e.currentTarget;
                  if (el.src !== '/avatar.png') el.src = '/avatar.png';
                }}
                role="button"
                tabIndex={0}
                title="このユーザーの投稿を見る"
                style={{ cursor: 'pointer' }}
              />

              <div className="friend-main">
                <div className="friend-name">
                  <button
                    className="linklike"
                    onClick={() => goProfile(f)}
                    title="プロフィールを見る"
                  >
                    {f.name || '(名前未設定)'}
                  </button>{' '}
                  <span className={`level-badge lv-${f.level}`}>{f.level}</span>
                </div>

                <div className="friend-sub">
                  @{f.user_code}
                  {f.lastMessageAt && (
                    <>
                      <span className="dot">・</span>
                      <span className="last-active">
                        {new Date(f.lastMessageAt).toLocaleString()}
                      </span>
                    </>
                  )}
                </div>

                {f.lastMessageText && (
                  <div className="snippet" title={f.lastMessageText}>
                    {f.lastMessageText}
                  </div>
                )}
              </div>

              <div
                className="friend-action"
                style={{ display: 'flex', gap: 8, alignItems: 'center' }}
              >
                {Number(f.unreadCount ?? 0) > 0 ? (
                  <span
                    className="unread-badge"
                    aria-label={`${Number(f.unreadCount ?? 0)}件の未読`}
                  >
                    {Number(f.unreadCount) > 99 ? '99+' : Number(f.unreadCount)}
                  </span>
                ) : (
                  <span className="unread-badge empty" aria-hidden="true" />
                )}

                <button className="chip-go" onClick={() => goFTalk(f)}>
                  FTalk
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
