// /src/components/ReactionBar.tsx
'use client';

import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getSupabaseBrowser } from '@/lib/supabase-browser';

/** 使えるリアクションの種類 */
type ReactionType = 'like' | 'heart' | 'smile' | 'wow' | 'share';

type Counts = Partial<Record<ReactionType, number>>;

type ReactionBarProps = {
  /** 対象ポストのID（必須） */
  postId: string;
  /** 同一スレッドID（子ポストの場合に渡す／親なら null でOK） */
  threadId?: string | null;
  /** 親ポスト用のボタン群なら true */
  isParent?: boolean;
  /** 初期の合計カウント（省略可） */
  initialCounts?: Counts;
  /** 押下を無効化して数のみ表示したい場合に指定 */
  readOnly?: boolean;
  /** 認証コンテキストではなく外部から閲覧者の userCode を渡したい場合に使用（省略可） */
  userCode?: string;
  /** 自分が既に押しているリアクション（省略可） */
  initialMyReactions?: ReactionType[];
  /** 反映後に親へ通知したい時のフック（省略可） */
  onChangeTotals?: (totals: Counts) => void;
};

/* =========================================================
 * API 呼び出しユーティリティ
 * =======================================================*/
async function toggleReactionClient(params: {
  post_id: string;
  reaction: ReactionType;
  is_parent?: boolean;
  thread_id?: string | null;
  user_code: string;
}) {
  const res = await fetch('/api/reactions/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[toggleReaction] ❌', res.status, data);
    throw new Error(data?.message || `toggleReaction failed (${res.status})`);
  }
  // サーバは totals または counts を返すことがあるため吸収
  const totals =
    (data?.totals && typeof data.totals === 'object' && data.totals) ||
    (data?.counts && typeof data.counts === 'object' && data.counts) ||
    (data?.data?.totals && data.data.totals) ||
    {};
  return { ok: true as const, totals: totals as Counts, post_id: data?.post_id ?? params.post_id };
}

/** 軽量な合計取得API（URL統一） */
async function fetchCounts(postId: string, isParent: boolean): Promise<Counts> {
  const q = new URLSearchParams({
    scope: 'post',
    post_id: postId,
    is_parent: String(isParent),
  });
  const res = await fetch(`/api/reactions/counts?${q.toString()}`, { cache: 'no-store' });
  const j = await res.json().catch(() => ({}));
  const totals =
    (j?.totals && typeof j.totals === 'object' && j.totals) ||
    (j?.counts && typeof j.counts === 'object' && j.counts) ||
    (j?.data?.totals && j.data.totals) ||
    {};
  return totals as Counts;
}

/* =========================================================
 * ReactionBar 本体
 * =======================================================*/
const ReactionBar: React.FC<ReactionBarProps> = ({
  postId,
  threadId = null,
  isParent = false,
  initialCounts,
  readOnly = false,
  userCode,
  initialMyReactions,
  onChangeTotals,
}) => {
  const { userCode: ctxUserCode } = useAuth();
  const effectiveUserCode = userCode ?? ctxUserCode;
  const [busyKey, setBusyKey] = useState<ReactionType | null>(null);

  // Supabase クライアント（ブラウザのみ）
  const sb = getSupabaseBrowser();

  // カウントのローカル状態（楽観更新）
  const [counts, setCounts] = useState<Counts>({
    like: 0,
    heart: 0,
    smile: 0,
    wow: 0,
    share: 0,
    ...initialCounts,
  });

  // 自分が押した状態（楽観更新）
  const [mine, setMine] = useState<Record<ReactionType, boolean>>(() => {
    const m: Record<ReactionType, boolean> = {
      like: false,
      heart: false,
      smile: false,
      wow: false,
      share: false,
    };
    (initialMyReactions || []).forEach((r) => (m[r] = true));
    return m;
  });

  // --- 初期propsの反映は「最初の一回だけ」行う（再レンダで0に戻さない） ---
  const didInitFromProps = useRef(false);
  useEffect(() => {
    if (!didInitFromProps.current) {
      if (initialCounts) {
        setCounts((prev) => ({ ...prev, ...initialCounts }));
      }
      didInitFromProps.current = true;
    }
    // postId が変わる場合のみ初期化を許可
  }, [postId]); // eslint-disable-line react-hooks/exhaustive-deps

  // initialMyReactions は変更時に同期（従来通り）
  useEffect(() => {
    if (!initialMyReactions) return;
    const next: Record<ReactionType, boolean> = {
      like: false,
      heart: false,
      smile: false,
      wow: false,
      share: false,
    };
    initialMyReactions.forEach((r) => (next[r] = true));
    setMine(next);
  }, [JSON.stringify(initialMyReactions || [])]);

  // クリックを許可できるか（readOnly または未ログインなら不可）
  const canInteract = useMemo(
    () => !readOnly && !!effectiveUserCode,
    [readOnly, effectiveUserCode],
  );

  // --- 単発リロード：多重実行抑止＋空レスで上書き禁止 ---
  const reloadInflight = useRef(false);
  const reload = useCallback(async () => {
    if (reloadInflight.current) return;
    reloadInflight.current = true;
    try {
      const t = await fetchCounts(postId, isParent);
      if (t && Object.keys(t).length) {
        setCounts((c) => ({ ...c, ...t }));
        onChangeTotals?.(t);
      }
    } catch (e) {
      // 失敗しても致命ではない
      console.warn('[ReactionBar] counts reload failed:', e);
    } finally {
      reloadInflight.current = false;
    }
  }, [postId, isParent, onChangeTotals]);

  // 初期ロード時、初期カウントが無い場合はAPIで取得（構造維持）
  useEffect(() => {
    if (!initialCounts) reload();
    // initialCounts が与えられている場合はそのまま使う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId, isParent]);

  // Realtime: reactions の対象 post_id の変化を購読して自動再取得
  useEffect(() => {
    if (!sb || !postId) return;
    const ch = sb
      .channel(`rx-post-${postId}`)
      .on(
        'postgres_changes',
        // ← 実DBテーブル名に合わせる（post_resonances）
        { event: '*', schema: 'public', table: 'post_resonances', filter: `post_id=eq.${postId}` },
        () => reload(),
      )
      .subscribe();
    return () => {
      sb.removeChannel(ch);
    };
  }, [sb, postId, reload]);

  // グローバル“即時反映”イベント（トグル後に投げる）
  useEffect(() => {
    const h = (e: any) => {
      const pid = e?.detail?.post_id;
      if (pid === postId) reload();
    };
    window.addEventListener('reactions:refresh', h as EventListener);
    return () => window.removeEventListener('reactions:refresh', h as EventListener);
  }, [postId, reload]);

  const handleToggle = async (reaction: ReactionType) => {
    if (!canInteract || busyKey) return;

    setBusyKey(reaction);

    // 楽観更新
    const prevMine = mine[reaction];
    setMine((s) => ({ ...s, [reaction]: !prevMine }));
    setCounts((c) => ({
      ...c,
      [reaction]: Math.max(0, (c[reaction] || 0) + (prevMine ? -1 : 1)),
    }));

    try {
      const res = await toggleReactionClient({
        post_id: postId,
        reaction,
        is_parent: isParent,
        thread_id: threadId ?? null,
        user_code: effectiveUserCode!, // 呼び出し元で未ログインは onClick 自体不許可
      });

      if (res?.totals && Object.keys(res.totals).length) {
        setCounts((c) => ({ ...c, ...res.totals }));
        onChangeTotals?.(res.totals);
      } else {
        // サーバが合計を返さない/空の場合は明示リロード
        await reload();
      }

      // 即時反映イベント（他の同一postのバーも追従）
      window.dispatchEvent(new CustomEvent('reactions:refresh', { detail: { post_id: postId } }));
    } catch (e: any) {
      // ロールバック
      console.error(e);
      const prevMine2 = !mine[reaction]; // 直前で反転している
      setMine((s) => ({ ...s, [reaction]: prevMine2 }));
      setCounts((c) => ({
        ...c,
        [reaction]: Math.max(0, (c[reaction] || 0) + (prevMine2 ? -1 : 1)),
      }));
      alert(`リアクションに失敗しました：${e?.message || 'Unknown Error'}`);
    } finally {
      setBusyKey(null);
    }
  };

  /* ---------- 表示 ---------- */
  const items: { key: ReactionType; label: string; aria: string }[] = [
    { key: 'share', aria: '共有', label: '🔁' },
    { key: 'like', aria: 'いいね', label: '👍' },
    { key: 'heart', aria: 'ハート', label: '❤️' },
    { key: 'smile', aria: 'スマイル', label: '😊' },
    { key: 'wow', aria: 'ワオ', label: '✨' },
  ];

  return (
    <div
      className={`reaction-bar${!canInteract ? ' readonly' : ''}`}
      aria-label="Reactions"
      // 折り返し防止 + 横スクロール許可（極小画面対策）
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'nowrap', // ← 1段固定
        whiteSpace: 'nowrap',
        overflowX: 'auto', // ← 幅不足時は横スクロール
        WebkitOverflowScrolling: 'touch' as any,
      }}
    >
      {items.map(({ key, label, aria }) => {
        const active = !!mine[key];
        const n = counts[key] || 0;

        return (
          <button
            key={key}
            type="button"
            aria-label={`${aria}（現在 ${n}件）`}
            aria-disabled={!canInteract ? 'true' : 'false'} // 見た目はそのまま
            onClick={canInteract ? () => handleToggle(key) : undefined}
            // 読取専用や未ログインでは disabled を使わない（半透明化防止）
            disabled={canInteract ? busyKey === key : false} // 通信中のみ disabled
            className={`reaction-button ${active ? 'is-active' : ''}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              borderRadius: 20,
              border: '1px solid #ddd',
              background: active ? '#fff3d1' : '#ffffff',
              cursor: canInteract ? (busyKey ? 'progress' : 'pointer') : 'default',
              opacity: busyKey === key ? 0.6 : 1,
              userSelect: 'none',
              flex: '0 0 auto',
              pointerEvents: canInteract ? 'auto' : 'none', // クリック不可
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>{label}</span>
            <span style={{ fontSize: 12, lineHeight: 1 }}>{n}</span>
          </button>
        );
      })}
    </div>
  );
};

export default ReactionBar;
