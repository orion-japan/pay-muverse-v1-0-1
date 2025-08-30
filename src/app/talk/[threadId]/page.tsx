// /app/talk/[threadId]/page.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import './thread.css';

/* ========== 型 ========== */
type ChatRow = {
  id?: string;
  chat_id?: string;
  thread_id: string;
  sender_code: string;
  receiver_code?: string | null;
  message?: string | null;
  body?: string | null;
  created_at: string;
  read_at?: string | null;
  _pending?: boolean;
  _error?: boolean;
};

type Profile = { user_code: string; name: string | null; avatar_url: string | null };

/* ========== ログ ========== */
const DEBUG = true;
const dlog = (...a: any[]) => DEBUG && console.log('[FTalk]', ...a);

/* ========== ユーティリティ ========== */
/** 見本方式：完全URL/dataURL/Storage相対/avatarsキー/ファイル名だけ すべて解決 */
const getAvatar = (url: string | null | undefined) => {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
  const u = (url ?? '').trim();
  if (!u) return '/avatar.png';
  if (/^https?:\/\//i.test(u) || /^data:image\//i.test(u)) return u;                   // 既に完全URL
  if (u.startsWith('/storage/v1/object/public/')) return `${base}${u}`;                 // Storage相対
  if (u.startsWith('avatars/')) return `${base}/storage/v1/object/public/${u}`;         // avatarsキー
  return `${base}/storage/v1/object/public/avatars/${u}`;                               // ファイル名のみ
};

const rowKey = (r: ChatRow) =>
  r.id || r.chat_id || `${r.thread_id}:${r.sender_code}:${r.created_at}`;
const rowText = (r: ChatRow) => (r.message ?? r.body ?? '') as string;

const normalizeThreadId = (a?: string, b?: string) =>
  [a ?? '', b ?? ''].sort((x, y) => x.localeCompare(y)).join('__');

/* ========== 画面本体 ========== */
export default function PairTalkPage() {
  const router = useRouter();
  const params = useParams<{ threadId: string }>();
  const threadId = decodeURIComponent(params.threadId);
  dlog('mount threadId =', threadId);

  const { userCode: myCode } = useAuth() as any;
  dlog('myCode =', myCode);

  useEffect(() => {
    if (!threadId) return;
    const [a, b] = (threadId || '').split('__');
    if (!a || !b) return;
    const normalized = normalizeThreadId(a, b);
    if (normalized && normalized !== threadId) {
      router.replace(`/talk/${encodeURIComponent(normalized)}`);
    }
  }, [threadId, router]);

  const peerCode = useMemo(() => {
    if (!myCode) return null;
    const [a, b] = (threadId || '').split('__');
    return a === myCode ? b : a;
  }, [threadId, myCode]);

  const [me, setMe] = useState<Profile | null>(null);
  const [peer, setPeer] = useState<Profile | null>(null);

  const [msgs, setMsgs] = useState<ChatRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const sendingRef = useRef(false);
  const lastAtRef = useRef<string | null>(null);
  const mountedRef = useRef(false);

  const autoResizeAndSet = (v: string) => {
    setText(v);
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
  };

  /* ---- プロフィール取得 ---- */
  useEffect(() => {
    (async () => {
      if (!myCode || !peerCode) return;
      const { data: meP } = await supabase
        .from('profiles')
        .select('user_code,name,avatar_url')
        .eq('user_code', myCode)
        .maybeSingle();
      const { data: peP } = await supabase
        .from('profiles')
        .select('user_code,name,avatar_url')
        .eq('user_code', peerCode)
        .maybeSingle();
      setMe(meP ?? { user_code: myCode, name: null, avatar_url: null });
      setPeer(peP ?? { user_code: peerCode, name: null, avatar_url: null });
      dlog('profiles loaded:', { me: meP, peer: peP });
    })();
  }, [myCode, peerCode]);

  /* ---- スクロール最下部 ---- */
  const scrollToBottom = () => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  };
  useEffect(() => {
    scrollToBottom();
  }, [msgs.length]);

  /* ---- メッセージ取得 ---- */
  const mergeNew = (items: ChatRow[]) => {
    if (!items?.length) return;
    setMsgs((prev) => {
      const map = new Map<string, ChatRow>();
      prev.forEach((r) => map.set(rowKey(r), r));

      for (const r of items) {
        const already = prev.some(
          (x) => (r.id && x.id === r.id) || (r.chat_id && x.chat_id === r.chat_id)
        );
        if (!already) {
          const tmpKey = [...map.keys()].find((k) => {
            const m = map.get(k);
            if (!m) return false;
            if (!m.chat_id?.startsWith('tmp-') || !m._pending) return false;
            const sameSender = m.sender_code === r.sender_code;
            const sameBody = rowText(m) === rowText(r);
            const dt = Math.abs(
              new Date(r.created_at).getTime() - new Date(m.created_at).getTime()
            );
            return sameSender && sameBody && dt < 30_000;
          });
          if (tmpKey) map.delete(tmpKey);
        }
        map.set(rowKey(r), r);
      }

      const arr = Array.from(map.values()).sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      const last = arr[arr.length - 1];
      if (last) lastAtRef.current = last.created_at;
      return arr;
    });
  };

  const fetchMessages = async (reason: string, cursor?: string | null) => {
    if (!threadId) return;
    try {
      const qs = new URLSearchParams({ thread_id: threadId });
      if (cursor) qs.set('cursor', cursor);
      const res = await fetch(`/api/talk/messages?${qs.toString()}`);
      if (!res.ok) throw new Error(await res.text());
      const { items } = (await res.json()) as { items: ChatRow[] };
      dlog(`fetch[${reason}]`, items?.length ?? 0);
      mergeNew(items || []);
    } catch (e) {
      console.error('[FTalk] fetch error:', e);
    }
  };

  /* ---- 既読化 ---- */
  const markRead = async (why: string) => {
    if (!threadId || !myCode) return;
    try {
      await fetch('/api/talk/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thread_id: threadId,
          user_code: myCode,
          until: lastAtRef.current ?? new Date().toISOString(),
        }),
      });
      dlog('read mark:', why);
    } catch (e) {
      console.warn('[FTalk] read mark error:', e);
    }
  };

  /* ---- 初期ロード ---- */
  useEffect(() => {
    mountedRef.current = true;
    setMsgs([]);
    lastAtRef.current = null;
    setLoading(true);
    (async () => {
      await fetchMessages('init', null);
      await markRead('after-init');
      setLoading(false);
      scrollToBottom();
    })();
    return () => {
      mountedRef.current = false;
    };
  }, [threadId]);

  /* ---- ポーリング ---- */
  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      await fetchMessages('poll', lastAtRef.current);
      await markRead('poll');
    };
    const id = setInterval(tick, 3000);
    tick();
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [threadId, myCode]);

  /* ---- フォーカス/復帰時 ---- */
  useEffect(() => {
    const onFocus = () => {
      fetchMessages('focus', lastAtRef.current);
      markRead('focus');
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        fetchMessages('visible', lastAtRef.current);
        markRead('visible');
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [threadId, myCode]);

  /* ---- 通知許可 ---- */
  useEffect(() => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default')
      Notification.requestPermission().catch(() => {});
  }, []);

  /* ---- 送信 ---- */
  const send = async () => {
    if (!text.trim() || !myCode || !peerCode || sendingRef.current) return;
    const body = text.trim();
    setText('');
    if (taRef.current) {
      taRef.current.style.height = 'auto';
      taRef.current.focus();
    }

    const temp: ChatRow = {
      chat_id: `tmp-${Date.now()}`,
      thread_id: threadId,
      sender_code: myCode,
      receiver_code: peerCode,
      body,
      created_at: new Date().toISOString(),
      read_at: null,
      _pending: true,
    };
    setMsgs((prev) => [...prev, temp]);
    scrollToBottom();

    sendingRef.current = true;
    try {
      const res = await fetch('/api/talk/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thread_id: threadId,
          a_code: myCode,
          b_code: peerCode,
          sender_code: myCode,
          body,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchMessages('after-send', lastAtRef.current);
      await markRead('after-send');
      dlog('send ok');
    } catch (e) {
      console.error('[FTalk] send failed:', e);
      setMsgs((prev) =>
        prev.map((m) =>
          m.chat_id === temp.chat_id ? { ...m, _pending: false, _error: true } : m
        )
      );
    } finally {
      sendingRef.current = false;
      scrollToBottom();
    }
  };

  /* ---- 再送 ---- */
  const retrySend = async (m: ChatRow) => {
    if (!m._error) return;
    setMsgs((prev) =>
      prev.map((x) =>
        rowKey(x) === rowKey(m) ? { ...x, _error: false, _pending: true } : x
      )
    );
    try {
      const res = await fetch('/api/talk/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thread_id: threadId,
          a_code: myCode,
          b_code: peerCode,
          sender_code: myCode,
          body: rowText(m),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchMessages('after-retry', lastAtRef.current);
    } catch (e) {
      console.error('[FTalk] retry failed:', e);
      setMsgs((prev) =>
        prev.map((x) =>
          rowKey(x) === rowKey(m) ? { ...x, _pending: false, _error: true } : x
        )
      );
    }
  };

  const isMe = (r: ChatRow) => r.sender_code === myCode;

  /* ---- UI ---- */
  return (
    <div className="ftalk-wrap">
      <header className="ftalk-head">
        <button className="back" onClick={() => router.back()}>
          &larr;
        </button>
        <div className="title">
          <img
            src={getAvatar(peer?.avatar_url)}
            alt=""
            className="mini"
            onError={(e) => {
              if (e.currentTarget.src !== '/avatar.png') e.currentTarget.src = '/avatar.png';
            }}
          />
          <span className="name">{peer?.name ?? peerCode}</span>
        </div>
        <div className="me-mini">
          <img
            src={getAvatar(me?.avatar_url)}
            alt=""
            className="mini"
            onError={(e) => {
              if (e.currentTarget.src !== '/avatar.png') e.currentTarget.src = '/avatar.png';
            }}
          />
        </div>
        <button
          className="qr"
          onClick={() => alert('（QRは後日API化予定。現状はダミーです）')}
        >
          Qコード
        </button>
      </header>

      <main className="ftalk-main">
        {loading ? (
          <div className="empty">読み込み中...</div>
        ) : msgs.length === 0 ? (
          <div className="empty">まだメッセージはありません。</div>
        ) : (
          <div className="timeline">
            {msgs.map((m) => {
              const mine = isMe(m);
              const pending = m._pending;
              const error = m._error;
              return (
                <div key={rowKey(m)} className={`row ${mine ? 'me' : 'you'}`}>
                  {!mine && (
                    <img
                      className="avatar you"
                      src={getAvatar(peer?.avatar_url)}
                      alt=""
                      onError={(e) => {
                        if (e.currentTarget.src !== '/avatar.png') e.currentTarget.src = '/avatar.png';
                      }}
                    />
                  )}
                  <div
                    className={`bubble ${pending ? 'pending' : ''} ${error ? 'error' : ''}`}
                  >
                    {!mine && <div className="who">{peer?.name ?? peerCode}</div>}
                    <div className="text">{rowText(m)}</div>
                    <div className="meta">
                      {new Date(m.created_at).toLocaleString()}
                      {pending && <span className="meta-tag">送信中…</span>}
                      {error && (
                        <button className="meta-tag retry" onClick={() => retrySend(m)}>
                          再送
                        </button>
                      )}
                    </div>
                  </div>
                  {mine && (
                    <img
                      className="avatar me"
                      src={getAvatar(me?.avatar_url)}
                      alt=""
                      onError={(e) => {
                        if (e.currentTarget.src !== '/avatar.png') e.currentTarget.src = '/avatar.png';
                      }}
                    />
                  )}
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        )}
      </main>

      <footer className="ftalk-input">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => autoResizeAndSet(e.target.value)}
          placeholder="メッセージを入力（Enterで送信 / Shift+Enterで改行）"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
        />
        <button className="send-btn" onClick={send} disabled={!text.trim()}>
          送信
        </button>
      </footer>
    </div>
  );
}
