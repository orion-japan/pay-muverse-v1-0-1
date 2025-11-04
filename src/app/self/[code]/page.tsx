'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import ReactionBar from '@/components/ReactionBar';
import QCodeBadge from '@/components/QCodeBadge';
import './self.css';

type Profile = {
  user_code: string;
  name: string;
  avatar_url?: string | null;
};

type BasePost = {
  post_id: string;
  title?: string | null;
  content?: string | null;
  created_at: string;
  board_type?: string | null;
  user_code?: string | null;
  thread_id?: string | null; // 子に付く
  is_posted?: boolean | null; // true=親 / false=子
};

type ReactionCount = { r_type: string; count: number };
type Item = BasePost & { kind: 'parent' | 'child' };

const BOARD_TYPE = 'self';
const DEFAULT_AVATAR = '/iavatar_default.png';

export default function SelfPage() {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname(); // 戻り時の再マウント用キー
  const { userCode: viewerUserCode } = useAuth();

  // /self/[code] の [code]
  const code: string | null = useMemo(() => {
    const raw = params?.code as string | string[] | undefined;
    if (!raw) return null;
    return Array.isArray(raw) ? raw[0] : raw;
  }, [params]);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [countsMap, setCountsMap] = useState<Record<string, ReactionCount[]>>({});
  const [loading, setLoading] = useState(true);

  // ▼ 絞り込み & 検索
  const [filterKind, setFilterKind] = useState<'all' | 'parent' | 'child'>('all');
  const [searchTerm, setSearchTerm] = useState('');

  // 入力デバウンスで検索負荷軽減
  function useDebounced<T>(value: T, delay = 250) {
    const [v, setV] = useState(value);
    useEffect(() => {
      const t = setTimeout(() => setV(value), delay);
      return () => clearTimeout(t);
    }, [value, delay]);
    return v;
  }
  const debouncedTerm = useDebounced(searchTerm, 250);

  // 描画用にフィルタした配列
  const visibleItems = useMemo(() => {
    const term = debouncedTerm.trim().toLowerCase();
    return items.filter((it) => {
      if (filterKind === 'parent' && it.kind !== 'parent') return false;
      if (filterKind === 'child' && it.kind !== 'child') return false;
      if (term) {
        const text = `${it.title ?? ''} ${it.content ?? ''}`.toLowerCase();
        if (!text.includes(term)) return false;
      }
      return true;
    });
  }, [items, filterKind, debouncedTerm]);

  // 直近のイベント重複反映ガード
  const seen = useRef<Set<string>>(new Set());

  const toArray = (v: any): any[] =>
    Array.isArray(v)
      ? v
      : Array.isArray(v?.data)
        ? v.data
        : Array.isArray(v?.items)
          ? v.items
          : Array.isArray(v?.rows)
            ? v.rows
            : [];

  // ReactionBar 用：配列→オブジェクト
  type CountsLike = Partial<{
    like: number;
    heart: number;
    smile: number;
    wow: number;
    share: number;
  }>;
  const toCounts = (arr?: ReactionCount[] | null): CountsLike => {
    const out: CountsLike = {};
    if (!arr) return out;
    const allow = new Set(['like', 'heart', 'smile', 'wow', 'share']);
    for (const a of arr) {
      const k = String(a?.r_type || '').toLowerCase();
      if (allow.has(k)) (out as any)[k] = a?.count ?? 0;
    }
    return out;
  };

  /** 共鳴カウントURL（親/子を指定） */
  const countsUrl = (postId: string, isParent: boolean) =>
    `/api/reactions/counts?scope=post&post_id=${encodeURIComponent(postId)}&is_parent=${isParent ? 'true' : 'false'}`;

  const fetchCountsOne = async (
    postId: string,
    isParent: boolean,
  ): Promise<ReactionCount[] | null> => {
    const url = countsUrl(postId, isParent);
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      const json = await res.json().catch(() => null);
      const totals: Record<string, number> | undefined =
        json && (json.totals || json.counts || json.data);
      if (!totals) return null;
      return Object.entries(totals).map(([r_type, count]) => ({
        r_type,
        count: (count as number) ?? 0,
      }));
    } catch {
      return null;
    }
  };

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

  // 初期取得：親（API）＋子（Supabase直接）をマージ
  useEffect(() => {
    if (!code) return;
    const ac = new AbortController();
    let mounted = true;
    setLoading(true);

    (async () => {
      try {
        // 親：API（is_posted=true 想定）
        const url = `/api/self-posts?userCode=${encodeURIComponent(code)}&boardType=${BOARD_TYPE}`;
        const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
        const parentListRaw: BasePost[] = res.ok ? toArray(await res.json()) : [];
        const parents: Item[] = parentListRaw
          .filter(
            (p) =>
              p.user_code === code &&
              (!p.board_type || String(p.board_type).toLowerCase() === BOARD_TYPE),
          )
          .map((p) => ({ ...p, kind: 'parent' as const, is_posted: true }));

        // 子：Supabase 直叩き（is_posted=false）
        const { data: childRows } = await supabase
          .from('posts')
          .select(
            'post_id, title, content, created_at, thread_id, user_code, board_type, is_posted',
          )
          .eq('user_code', code)
          .eq('is_posted', false)
          .order('created_at', { ascending: false });

        const children: Item[] = (childRows || [])
          .filter((c) => !c.board_type || String(c.board_type).toLowerCase() === BOARD_TYPE)
          .map((c) => ({ ...c, kind: 'child' as const }));

        const merged = [...parents, ...children].sort(
          (a, b) => +new Date(b.created_at) - +new Date(a.created_at),
        );

        if (mounted && !ac.signal.aborted) {
          setItems(merged);

          // 親/子それぞれのカウントを並列取得
          const entries = await Promise.all(
            merged.map(
              async (it) =>
                [it.post_id, await fetchCountsOne(it.post_id, it.kind === 'parent')] as const,
            ),
          );
          if (mounted && !ac.signal.aborted) {
            const next: Record<string, ReactionCount[]> = {};
            for (const [id, arr] of entries) next[id] = arr ?? [];
            setCountsMap(next);
          }
        }
      } catch (e: any) {
        if (e?.name !== 'AbortError') console.error('[Self/[code]] init fetch error:', e);
      } finally {
        if (mounted && !ac.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
      ac.abort();
    };
  }, [code]);

  // Realtime（このユーザーの self の親/子どちらも）
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

      setItems((prev) => {
        const kind: Item['kind'] = row?.is_posted === false ? 'child' : 'parent';
        const idx = prev.findIndex((p) => p.post_id === row.post_id);
        if (idx === -1) {
          const next = [{ ...(row as BasePost), kind }, ...prev].sort(
            (a, b) => +new Date(b.created_at) - +new Date(a.created_at),
          );
          refetchCounts(next);
          return next;
        }
        const next = [...prev];
        next[idx] = { ...next[idx], ...(row as BasePost), kind };
        return next;
      });
    };

    const remove = (row: any) => {
      if (row?.user_code !== code) return;
      setItems((prev) => {
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
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [code]);

  // カウント再取得（親/子を区別）
  const refetchCounts = async (list = items) => {
    try {
      if (!list.length) {
        setCountsMap({});
        return;
      }
      const entries = await Promise.all(
        list.map(
          async (it) =>
            [it.post_id, await fetchCountsOne(it.post_id, it.kind === 'parent')] as const,
        ),
      );
      const next: Record<string, ReactionCount[]> = {};
      for (const [id, arr] of entries) next[id] = arr ?? [];
      setCountsMap(next);
    } catch {
      setCountsMap({});
    }
  };

  // code が無いアクセスはホームへ
  useEffect(() => {
    if (code === null) router.replace('/');
  }, [code, router]);

  // アバター：/api/avatar/[code] を第一候補にし、1分ごとにキャッシュバスター
  const avatarSrcOf = (p?: Profile | null) => {
    const c = p?.user_code?.trim();
    if (!c) return DEFAULT_AVATAR;
    const ver = Math.floor(Date.now() / 60000); // 1分単位でクエリ更新
    return `/api/avatar/${encodeURIComponent(c)}?v=${ver}`;
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });

  // クリックでスレッドへ移動
  const goThread = (it: Item) => {
    if (it.kind === 'child' && it.thread_id) {
      router.push(`/thread/${it.thread_id}?goto=${it.post_id}`);
    } else {
      router.push(`/thread/${it.post_id}`);
    }
  };

  // 自前の「戻る」: 常に /self へ。URLに時刻を付与して一覧側を確実に再マウント
  const goSelf = () => {
    const ts = Date.now();
    router.push(`/self?fromCode=${encodeURIComponent(code || '')}&ts=${ts}`);
  };

  return (
    // key={pathname} を付与：このページ自体も戻り時に再マウント
    <div key={pathname} className="self-page">
      {/* ← 戻る */}
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
        <button
          type="button"
          onClick={goSelf}
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
            style={{ borderRadius: '50%', display: 'block', objectFit: 'cover' }}
            onError={(e) => {
              const img = e.currentTarget as HTMLImageElement;
              if (img.src !== new URL(DEFAULT_AVATAR, location.origin).toString()) {
                img.src = DEFAULT_AVATAR; // APIが404でも最後は既定へ
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

      <h3>🧠 Self 投稿（親＋子）</h3>

      {/* ▼ フィルタ UI */}
      <div style={{ display: 'flex', gap: 12, margin: '16px 0' }}>
        <select
          value={filterKind}
          onChange={(e) => setFilterKind(e.target.value as 'all' | 'parent' | 'child')}
          style={{ padding: '4px 8px', borderRadius: 6 }}
        >
          <option value="all">全て</option>
          <option value="parent">親のみ</option>
          <option value="child">子のみ</option>
        </select>

        <input
          type="text"
          placeholder="キーワード検索"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ flex: 1, padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc' }}
        />
      </div>

      {loading ? (
        <p>読み込み中...</p>
      ) : visibleItems.length === 0 ? (
        <p>該当する投稿がありません</p>
      ) : (
        <ul className="self-list">
          {visibleItems.map((it) => (
            <li
              key={it.post_id}
              className="self-item"
              onClick={() => goThread(it)}
              style={{ cursor: 'pointer' }}
            >
              <div
                className="self-item-title"
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <strong>{it.title ?? '(本文なし)'}</strong>
                {it.kind === 'child' && (
                  <span
                    style={{
                      fontSize: 12,
                      padding: '2px 6px',
                      border: '1px solid #bbb',
                      borderRadius: 6,
                      background: '#f7f7f7',
                    }}
                    title="このユーザーによる返信（子投稿）"
                  >
                    返信
                  </span>
                )}
              </div>

              {it.content && <p className="self-item-content">{it.content}</p>}
              <small className="date">{formatDate(it.created_at)}</small>

              {/* 共鳴バー（クリックでスレ遷移しないよう stopPropagation） */}
              <div
                className="actions-row"
                style={{ marginTop: 8, display: 'flex', justifyContent: 'center' }} // 中央寄せ
                onClick={(e) => e.stopPropagation()}
              >
                <ReactionBar
                  postId={it.post_id}
                  userCode={viewerUserCode || ''}
                  threadId={it.kind === 'child' ? it.thread_id || null : null}
                  isParent={it.kind === 'parent'}
                  initialCounts={toCounts(countsMap[it.post_id])}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
