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

/** 画像URLを解決（無効なら /avatar.png） */
function resolveAvatarUrl(url: string | null): string {
  const u = (url ?? '').trim();
  if (!u) return '/avatar.png';
  if (u.startsWith('/')) return u;
  if (/^https?:\/\//i.test(u) || /^data:image\//i.test(u)) return u;
  return '/avatar.png';
}

/** 相互F以上の友だち（profiles.name / avatar_url を含む） */
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

/** chats から各相手との最新メッセージ＆未読件数を取得（スキーマ：receiver_code / read_at） */
async function hydrateThreadsMeta(
  myCode: string,
  friends: FriendItem[],
): Promise<Record<string, Pick<FriendItem, 'lastMessageAt' | 'lastMessageText' | 'unreadCount'>>> {
  if (!friends.length) return {};
  const threadIds = friends.map((f) => threadIdOf(myCode, f.user_code));

  // thread_id 生成列がある前提（なければ DB 追加済みか確認）
  const { data, error } = await supabase
    .from('chats')
    .select('thread_id, sender_code, receiver_code, message, created_at, read_at')
    .in('thread_id', threadIds)
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error) {
    console.warn('[Talk] chats meta fetch error:', error.message);
    return {};
  }

  const map: Record<
    string,
    { lastAt?: string; lastText?: string; unread: number }
  > = {};

  for (const row of (data ?? []) as any[]) {
    const tid: string = row.thread_id;
    const recipient: string | null = row.receiver_code ?? null;
    const body: string | null = row.message ?? null;
    const ts: string | null = row.created_at ?? null;

    if (!map[tid]) map[tid] = { lastAt: undefined, lastText: undefined, unread: 0 };

    // 最新メッセージ
    if (ts && (!map[tid].lastAt || ts > (map[tid].lastAt as string))) {
      map[tid].lastAt = ts;
      map[tid].lastText = body ?? '';
    }

    // 未読（自分宛 && read_at が NULL）
    if (recipient === myCode && row.read_at == null) {
      map[tid].unread += 1;
    }
  }

  const out: Record<string, Pick<FriendItem, 'lastMessageAt' | 'lastMessageText' | 'unreadCount'>> =
    {};
  for (const f of friends) {
    const tid = threadIdOf(myCode, f.user_code);
    const r = map[tid];
    out[f.user_code] = {
      lastMessageAt: r?.lastAt ?? null,
      lastMessageText: r?.lastText ?? null,
      unreadCount: r?.unread ?? 0,
    };
  }
  return out;
}

/** クリックログ（失敗しても遷移は継続） */
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

  const blocked = planStatus === 'free';

  // 友だちリスト取得＋メタ付与（最新/未読）
  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      try {
        if (!userCode) {
          if (mounted) setFriends([]);
          return;
        }
        const list = await fetchMutualFriends(userCode);
        const meta = await hydrateThreadsMeta(userCode, list);
        const enriched = list.map((f) => ({ ...f, ...meta[f.user_code] }));
        const sorted = enriched.sort((a, b) => {
          const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
          const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
          if (tb !== ta) return tb - ta; // 最近の投稿が上
          return (a.name ?? '').localeCompare(b.name ?? '', 'ja');
        });
        if (mounted) setFriends(sorted);
      } catch (e) {
        console.error('[Talk] fetch error:', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [userCode]);

  // 検索
  const filtered = useMemo(() => {
    if (!q.trim()) return friends;
    const key = q.toLowerCase();
    return friends.filter(
      (f) =>
        f.user_code.toLowerCase().includes(key) ||
        (f.name ?? '').toLowerCase().includes(key),
    );
  }, [q, friends]);

  const goFTalk = async (friend: FriendItem) => {
    if (!userCode) return;
    // ログは任意（下の②参照）
    await logOpenFTalk(userCode, friend.user_code);
    const threadId = threadIdOf(userCode, friend.user_code);
    router.push(`/talk/${threadId}`);
  };

  const goProfile = (friend: FriendItem) => {
    router.push(`/profile/${encodeURIComponent(friend.user_code)}`);
  };

  return (
    <div className="talk-shell">
      <header className="talk-header">
        <h1>Talk</h1>
        <p className="talk-note">
          両想い（<b>F以上</b>）の友達だけが表示されます。
          {blocked && (
            <span className="talk-note-warn">
              {' '}現在プラン: free（閲覧のみ・開始はアップグレード後に可能）
            </span>
          )}
        </p>
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
              />

              <div className="friend-main">
                <div className="friend-name">
                  {/* 名前押しでプロフィールへ */}
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

              <div className="friend-action" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {f.unreadCount && f.unreadCount > 0 ? (
                  <span className="unread-badge" aria-label={`${f.unreadCount}件の未読`}>
                    {f.unreadCount > 99 ? '99+' : f.unreadCount}
                  </span>
                ) : (
                  <span className="unread-badge empty" aria-hidden="true" />
                )}
                <button
                  className="chip-go"
                  onClick={() => goFTalk(f)}
                  aria-label={`FTalkへ (${f.name ?? f.user_code})`}
                  title={blocked ? '現在プラン: free（アップグレードで開始可能）' : 'FTalkへ'}
                >
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
