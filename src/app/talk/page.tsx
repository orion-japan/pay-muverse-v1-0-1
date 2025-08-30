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

  // すでに完全URL or dataURL
  if (/^https?:\/\//i.test(u) || /^data:image\//i.test(u)) return u;

  // /storage/v1/object/public/... で始まる相対
  if (u.startsWith('/storage/v1/object/public/')) return `${base}${u}`;

  // avatars/xxx などのキー（バケット名を含む）
  if (u.startsWith('avatars/')) return `${base}/storage/v1/object/public/${u}`;

  // ファイル名だけが入っているケース（見本に合わせて avatars バケットに寄せる）
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

async function hydrateThreadsMeta(
  myCode: string,
  friends: FriendItem[],
): Promise<Record<string, Pick<FriendItem,'lastMessageAt'|'lastMessageText'|'unreadCount'>>> {
  if (!friends.length) return {};
  const threadIds = friends.map((f) => threadIdOf(myCode, f.user_code));

  // --- 未読行をそのまま取得 → JSで集計（送信者が自分以外 = 自分宛）---
  const { data: unreadRows, error: unreadErr } = await supabase
    .from('chats')
    .select('thread_id, sender_code, read_at')      // 集計しない
    .in('thread_id', threadIds)
    .neq('sender_code', myCode)                     // ★ 送信者が自分以外
    .is('read_at', null);                           // 未読のみ

  if (unreadErr) console.warn('[Talk] unread rows error:', unreadErr.message);

  const unreadMap = new Map<string, number>();
  for (const r of (unreadRows ?? []) as any[]) {
    const tid = String(r.thread_id);
    unreadMap.set(tid, (unreadMap.get(tid) ?? 0) + 1);
  }

  // --- 最新メッセ（従来どおり）---
  const { data: rows, error: rowsErr } = await supabase
    .from('chats')
    .select('thread_id, message, body, created_at')
    .in('thread_id', threadIds)
    .order('created_at', { ascending: false });

  if (rowsErr) console.warn('[Talk] chats meta fetch error:', rowsErr.message);

  const latestMap: Record<string, { at?: string; text?: string }> = {};
  for (const row of (rows ?? []) as any[]) {
    const tid = String(row.thread_id);
    if (!latestMap[tid]) {
      latestMap[tid] = {
        at: row.created_at ?? null,
        text: (row.message ?? row.body ?? '') as string,
      };
    }
  }

  // --- friends に合わせて整形 ---
  const out: Record<string, Pick<FriendItem,'lastMessageAt'|'lastMessageText'|'unreadCount'>> = {};
  for (const f of friends) {
    const tid = threadIdOf(myCode, f.user_code);
    out[f.user_code] = {
      lastMessageAt: latestMap[tid]?.at ?? null,
      lastMessageText: latestMap[tid]?.text ?? null,
      unreadCount: unreadMap.get(tid) ?? 0,
    };
  }

  // デバッグ（必要なら残す）
  console.table(friends.map((f) => ({
    user_code: f.user_code,
    thread_id: threadIdOf(myCode, f.user_code),
    unread: out[f.user_code]?.unreadCount ?? 0,
  })));

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

      // 未読ありを先頭 → その中で最新降順 → 残りも最新降順 → 最後に名前
      const sortedList = enrichedList.sort((a, b) => {
        const ua = (a.unreadCount ?? 0) > 0 ? 1 : 0;
        const ub = (b.unreadCount ?? 0) > 0 ? 1 : 0;
        if (ub !== ua) return ub - ua;
        const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
        const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
        if (tb !== ta) return tb - ta;
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

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!mounted) return;
      await loadFriends();
    })();
    return () => { mounted = false; };
  }, [userCode]); // userCode変化時に再読込

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadFriends();
    setRefreshing(false);
  };

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

  // 画像クリック → 投稿一覧（必要に応じて差し替え）
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
        <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          <p className="talk-note" style={{ margin:0 }}>
            両想い（<b>F以上</b>）の友達だけが表示されます。
            {blocked && (
              <span className="talk-note-warn">
                {' '}<br/>現在プラン: free（閲覧のみ・開始はアップグレード後に可能）
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
