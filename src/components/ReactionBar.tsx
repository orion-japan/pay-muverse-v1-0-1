'use client';

import React, { useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';

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
  /** 初期カウント（省略可） */
  initialCounts?: Counts;
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
    headers: { 'Content-Type': 'application/json' }, // ← 必須
    body: JSON.stringify(params),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[toggleReaction] ❌', res.status, data);
    throw new Error(data?.message || `toggleReaction failed (${res.status})`);
  }
  return data as { ok: true; totals?: Counts; post_id: string };
}

/* =========================================================
 * ReactionBar 本体
 * =======================================================*/
const ReactionBar: React.FC<ReactionBarProps> = ({
  postId,
  threadId = null,
  isParent = false,
  initialCounts,
  initialMyReactions,
  onChangeTotals,
}) => {
  const { userCode } = useAuth(); // ← プロジェクト既存の AuthContext から取得
  const [busyKey, setBusyKey] = useState<ReactionType | null>(null);

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

  const disabled = useMemo(() => !userCode || !!busyKey, [userCode, busyKey]);

  const handleToggle = async (reaction: ReactionType) => {
    if (!userCode) {
      alert('ログイン状態が確認できません。もう一度ログインしてください。');
      return;
    }
    if (busyKey) return;

    setBusyKey(reaction);

    // 楽観更新：押していなければ +1、押していれば -1
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
        user_code: userCode!,
      });

      // サーバーが totals を返す場合はそれを優先反映
      if (res?.totals) {
        setCounts((c) => ({ ...c, ...res.totals }));
        onChangeTotals?.(res.totals);
      }
    } catch (e: any) {
      // 失敗したらロールバック
      console.error(e);
      setMine((s) => ({ ...s, [reaction]: prevMine }));
      setCounts((c) => ({
        ...c,
        [reaction]: Math.max(0, (c[reaction] || 0) + (prevMine ? 1 : -1)),
      }));
      alert(`リアクションに失敗しました：${e?.message || 'Unknown Error'}`);
    } finally {
      setBusyKey(null);
    }
  };

  /* ---------- 表示 ---------- */
  // ここでは絵文字を使っています。既存のアイコンコンポーネントがあれば差し替えてください
  const items: { key: ReactionType; label: string; aria: string }[] = [
    { key: 'share', aria: '共有', label: '🔁' },
    { key: 'like', aria: 'いいね', label: '👍' },
    { key: 'heart', aria: 'ハート', label: '❤️' },
    { key: 'smile', aria: 'スマイル', label: '😊' },
    { key: 'wow', aria: 'ワオ', label: '✨' },
  ];

  return (
    <div
      className="reaction-bar"
      style={{
        display: 'flex',
        justifyContent: 'center', // ← 中央寄せ
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
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
            onClick={() => handleToggle(key)}
            disabled={disabled}
            className={`reaction-button ${active ? 'is-active' : ''}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              borderRadius: 20,
              border: '1px solid #ddd',
              background: active ? '#fff3d1' : '#ffffff',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: busyKey === key ? 0.6 : 1,
              userSelect: 'none',
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
