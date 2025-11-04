'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getAuth } from 'firebase/auth';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabaseClient'; // 必要に応じてパスを調整

/* ========= Debug ========= */
const DEBUG = true;
const dlog = (...a: any[]) => DEBUG && console.log('[CommentsSection]', ...a);

/* ========= Types ========= */
type CommentRow = {
  comment_id: string;
  post_id: string;
  user_code: string | null;
  content: string | null;
  created_at: string;
  is_deleted?: boolean | null;
};

type EnrichedComment = CommentRow & {
  display_name: string;
  avatar_url: string | null;
};

type Props = {
  postId: string;
  className?: string;
  /** 明示的に me を渡したい場合のみ指定（通常は Context/whoami で補完） */
  me?: string | null;
  /** 空の時の「コメントはまだありません」を隠す */
  hideEmpty?: boolean;
};

/* ========= Utils ========= */
const norm = (s?: string | null) => (s ?? '').trim().toLowerCase();
const formatJST = (d: string | number | Date) =>
  new Date(d).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/* ========= Component ========= */
export default function CommentsSection({
  postId,
  className,
  me: meProp = null,
  hideEmpty = false, // ★ デフォルト値
}: Props) {
  const { userCode } = useAuth() ?? {};
  const [me, setMe] = useState<string | null>(meProp ?? userCode ?? null);
  const [comments, setComments] = useState<EnrichedComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  /* ---- me を決定（Props > Context > whoami） ---- */
  useEffect(() => {
    const next = meProp ?? userCode ?? null;
    setMe(next);
    dlog('me resolved =', next, '(prop:', meProp, ', ctx:', userCode, ')');
  }, [meProp, userCode]);

  useEffect(() => {
    (async () => {
      if (me) return; // もう取得済み
      const auth = getAuth();
      const u = auth.currentUser;
      if (!u) {
        dlog('no firebase user; skip whoami');
        return;
      }
      try {
        const token = await u.getIdToken(true);
        const res = await fetch('/api/whoami', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        const j = await res.json().catch(() => ({}));
        dlog('whoami response =', res.status, j);
        const code = j?.userCode ?? j?.user_code;
        if (res.ok && j?.ok && code) setMe(String(code));
      } catch (e) {
        dlog('whoami error', e);
      }
    })();
  }, [me]);

  /* ---- コメント取得（is_deleted: NULL も未削除扱い） ---- */
  const fetchComments = useCallback(async () => {
    setLoading(true);
    setErrMsg(null);
    try {
      dlog('fetch start for postId =', postId);
      const { data, error } = await supabase
        .from('comments')
        .select('comment_id, post_id, user_code, content, created_at, is_deleted')
        .eq('post_id', postId)
        .or('is_deleted.is.null,is_deleted.eq.false') // NULL も未削除扱い
        .order('created_at', { ascending: true });

      if (error) throw error;

      const rows = (data || []) as CommentRow[];
      dlog('raw comments count =', rows.length, rows);

      // プロフィール補完
      const codes = Array.from(
        new Set(rows.map((r) => (r.user_code || '').trim()).filter(Boolean)),
      );
      const nameMap = new Map<string, { name: string; avatar_url: string | null }>();
      if (codes.length) {
        const { data: profs, error: pErr } = await supabase
          .from('profiles')
          .select('user_code,name,avatar_url')
          .in('user_code', codes);
        if (pErr) throw pErr;
        (profs || []).forEach((p: any) => {
          nameMap.set(p.user_code, {
            name: p.name ?? p.user_code,
            avatar_url: p.avatar_url ?? null,
          });
        });
      }

      const enriched: EnrichedComment[] = rows.map((r) => {
        const meta = r.user_code ? nameMap.get(r.user_code) : undefined;
        return {
          ...r,
          display_name: meta?.name || r.user_code || '匿名',
          avatar_url: meta?.avatar_url || null,
        };
      });

      dlog('enriched comments =', enriched);
      setComments(enriched);
    } catch (e: any) {
      dlog('fetch error', e);
      setErrMsg(e?.message ?? 'コメントの取得に失敗しました。');
      setComments([]);
    } finally {
      setLoading(false);
    }
  }, [postId]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  /* ---- 削除 ---- */
  const handleDelete = useCallback(async (comment_id: string) => {
    if (!confirm('このコメントを削除しますか？')) return;
    try {
      const u = getAuth().currentUser;
      if (!u) throw new Error('ログインが必要です');
      const token = await u.getIdToken(true);

      const res = await fetch('/api/thread/comment/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`, // 必須
        },
        body: JSON.stringify({ target: 'comment', id: comment_id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) throw new Error(j?.error || '削除に失敗しました');

      setComments((prev) => prev.filter((c) => c.comment_id !== comment_id));
    } catch (e: any) {
      alert(e?.message || '削除に失敗しました');
    }
  }, []);

  /* ---- 表示 ---- */
  const content = useMemo(() => {
    dlog(
      'render me =',
      me,
      'comments map =',
      comments.map((c) => ({ id: c.comment_id, uc: c.user_code })),
    );

    if (loading) return <div className="cmt-loading">読み込み中…</div>;
    if (errMsg) return <div className="cmt-error">{errMsg}</div>;
    if (!comments.length) {
      // ★ 空時の文言はフラグで出し分け
      return hideEmpty ? null : <div className="cmt-empty">コメントはまだありません。</div>;
    }

    return comments.map((c) => {
      const canDelete = !!me && !!c.user_code && norm(c.user_code) === norm(me);
      return (
        <div className="cmt-item" key={c.comment_id}>
          <img
            className="cmt-avatar"
            src={c.avatar_url || '/iavatar_default.png'}
            alt=""
            width={36}
            height={36}
            onError={(e) => {
              const el = e.currentTarget as HTMLImageElement;
              if (el.src !== '/iavatar_default.png') el.src = '/iavatar_default.png';
            }}
          />
          <div className="cmt-main">
            <div className="cmt-meta">
              <span className="cmt-name">{c.display_name}</span>

              {/* 右寄せブロック：日時＋削除 */}
              <div className="cmt-right">
                <span className="cmt-time">{formatJST(c.created_at)}</span>
                {canDelete && (
                  <button className="cmt-delete" onClick={() => handleDelete(c.comment_id)}>
                    削除
                  </button>
                )}
              </div>
            </div>

            {/* 本文を太字で */}
            <p className="cmt-content">
              <strong>{c.content}</strong>
            </p>
          </div>
        </div>
      );
    });
  }, [comments, loading, errMsg, me, handleDelete, hideEmpty]);

  return (
    <div className={`comments ${className ?? ''}`}>
      {content}

      <style jsx>{`
        .comments {
          width: 100%;
        }
        .cmt-loading,
        .cmt-empty,
        .cmt-error {
          font-size: 14px;
          color: #555;
          padding: 8px 4px;
        }
        .cmt-error {
          color: #b00020;
        }

        .cmt-item {
          display: flex;
          gap: 10px;
          padding: 10px 0;
          border-bottom: 1px solid #eee;
        }
        .cmt-avatar {
          border-radius: 50%;
          object-fit: cover;
          border: 1px solid #ddd;
        }
        .cmt-main {
          flex: 1 1 auto;
          min-width: 0;
        }

        /* メタ行：左=名前 / 右=日付+削除 */
        .cmt-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: #666;
          margin-bottom: 4px;
        }
        .cmt-name {
          font-weight: 600;
          color: #222;
        }
        .cmt-right {
          margin-left: auto;
          display: flex;
          align-items: center;
          gap: 8px;
          white-space: nowrap;
        }
        .cmt-time {
          font-variant-numeric: tabular-nums;
        }

        /* 本文：強調 */
        .cmt-content {
          margin: 0;
          font-size: 14px;
          line-height: 1.6;
          color: #222;
          word-break: break-word;
        }
        .cmt-content strong {
          font-weight: 800;
        } /* ← 太字をさらに強調（700〜900で調整可） */

        .cmt-delete {
          background: none;
          border: none;
          color: #cc3344;
          cursor: pointer;
          font-size: 13px;
          padding: 2px 6px;
          border-radius: 6px;
        }
        .cmt-delete:hover {
          background: #f7e9eb;
        }
      `}</style>
    </div>
  );
}
