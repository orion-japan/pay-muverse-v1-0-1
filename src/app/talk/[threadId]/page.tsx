// /app/talk/[threadId]/page.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import './thread.css';

/* ========== 型 ========== */
type ChatRow = {
  id?: string;                 // サーバ or DB により存在することがある
  chat_id?: string;            // 既存スキーマ互換
  thread_id: string;
  sender_code: string;
  receiver_code?: string | null;
  message?: string | null;     // 既存スキーマ互換
  body?: string | null;        // 新API（/api/talk/messages の insert ペイロード）
  created_at: string;
  read_at?: string | null;
  // 楽観表示用
  _pending?: boolean;
  _error?: boolean;
};

type Profile = { user_code: string; name: string | null; avatar_url: string | null };

/* ========== ログ ========== */
const DEBUG = true;
const dlog = (...a: any[]) => DEBUG && console.log('[FTalk]', ...a);

/* ========== ユーティリティ ========== */
const getAvatar = (url: string | null | undefined) => {
  const u = (url ?? '').trim();
  if (!u) return '/avatar.png';
  if (u.startsWith('/') || /^https?:\/\//i.test(u) || /^data:image\//i.test(u)) return u;
  return '/avatar.png';
};
const rowKey = (r: ChatRow) => r.chat_id || r.id || `${r.thread_id}:${r.sender_code}:${r.created_at}`;
const rowText = (r: ChatRow) => (r.message ?? r.body ?? '') as string;

// 2ユーザーの会話IDを昇順連結で規格化（ユーザー削除しない限り固定）
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

  // URL の threadId が規格化と違っていたら同ルートに置換（履歴を一つに固定）
  useEffect(() => {
    if (!threadId) return;
    const [a, b] = (threadId || '').split('__');
    if (!a || !b) return;
    const normalized = normalizeThreadId(a, b);
    if (normalized && normalized !== threadId) {
      router.replace(`/talk/${encodeURIComponent(normalized)}`);
    }
  }, [threadId, router]);

  // スレッドの相手コード（"小さい方__大きい方" のもう片方）
  const peerCode = useMemo(() => {
    if (!myCode) return null;
    const [a, b] = (threadId || '').split('__');
    const v = a === myCode ? b : a;
    dlog('peerCode =', v);
    return v ?? null;
  }, [threadId, myCode]);

  const [me, setMe] = useState<Profile | null>(null);
  const [peer, setPeer] = useState<Profile | null>(null);

  const [msgs, setMsgs] = useState<ChatRow[]>([]);
  const [loading, setLoading] = useState(true);

  // 入力
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // 状態管理
  const sendingRef = useRef(false);
  const lastAtRef = useRef<string | null>(null);
  const mountedRef = useRef(false);

  // テキストエリア自動高さ
  const autoResizeAndSet = (v: string) => {
    setText(v);
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
  };

  /* ---- プロフィール取得（read は supabase 直でOK） ---- */
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

  /* ---- スクロール最下部へ ---- */
  const scrollToBottom = () => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  };
  useEffect(() => { scrollToBottom(); }, [msgs.length]);

  /* ---- メッセージ取得（API 経由） ---- */
  const mergeNew = (items: ChatRow[]) => {
    if (!items?.length) return;
    setMsgs((prev) => {
      const map = new Map<string, ChatRow>();
      // 既存
      prev.forEach((r) => map.set(rowKey(r), r));
      // 新規
      items.forEach((r) => map.set(rowKey(r), r));
      const arr = Array.from(map.values()).sort((a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      // cursor 更新
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

  /* ---- 既読化（API 経由） ---- */
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

  /* ---- ポーリング（Realtime の代替・無限ループ防止） ---- */
  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      await fetchMessages('poll', lastAtRef.current);
      await markRead('poll');
    };
    const id = setInterval(tick, 3000);
    tick(); // 初回
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [threadId, myCode]);

  /* ---- フォーカス/復帰時に更新 ---- */
  useEffect(() => {
    const onFocus = () => { fetchMessages('focus', lastAtRef.current); markRead('focus'); };
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
    if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }, []);

  /* ---- 送信（API → service_role 経由） ---- */
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
          thread_id: threadId,  // 既存の固定ID（規格化済み）
          a_code: myCode,
          b_code: peerCode,
          sender_code: myCode,
          body,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      // 楽観 → 確定
      setMsgs((prev) =>
        prev.map((m) => (m.chat_id === temp.chat_id ? { ...m, _pending: false } : m))
      );
      await fetchMessages('after-send', lastAtRef.current);
      await markRead('after-send');
      dlog('send ok');
    } catch (e) {
      console.error('[FTalk] send failed:', e);
      setMsgs((prev) =>
        prev.map((m) => (m.chat_id === temp.chat_id ? { ...m, _pending: false, _error: true } : m))
      );
    } finally {
      sendingRef.current = false;
      scrollToBottom();
    }
  };

  // 再送（失敗行用）
  const retrySend = async (m: ChatRow) => {
    if (!m._error) return;
    setMsgs((prev) =>
      prev.map((x) => (rowKey(x) === rowKey(m) ? { ...x, _error: false, _pending: true } : x))
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
      setMsgs((prev) =>
        prev.map((x) => (rowKey(x) === rowKey(m) ? { ...x, _pending: false } : x))
      );
    } catch (e) {
      console.error('[FTalk] retry failed:', e);
      setMsgs((prev) =>
        prev.map((x) => (rowKey(x) === rowKey(m) ? { ...x, _pending: false, _error: true } : x))
      );
    }
  };

  const isMe = (r: ChatRow) => r.sender_code === myCode;

  /* ---- UI ---- */
  return (
    <div className="ftalk-wrap">
      {/* ヘッダ */}
      <header className="ftalk-head">
        <button className="back" onClick={() => router.back()}>&larr;</button>
        <div className="title">
          <img src={getAvatar(peer?.avatar_url)} alt="" className="mini" />
          <span className="name">{peer?.name ?? peerCode}</span>
        </div>
        {/* 自分のアバターもヘッダ右に表示（任意） */}
        <div className="me-mini">
          <img src={getAvatar(me?.avatar_url)} alt="" className="mini" />
        </div>
        <button className="qr" onClick={() => alert('（QRは後日API化済み。現状のままでもOK）')}>Qコード</button>
      </header>

      {/* タイムライン */}
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
                  {/* 相手のメッセージ → 左アバター */}
                  {!mine && <img className="avatar you" src={getAvatar(peer?.avatar_url)} alt="" />}
                  <div className={`bubble ${pending ? 'pending' : ''} ${error ? 'error' : ''}`}>
                    {!mine && <div className="who">{peer?.name ?? peerCode}</div>}
                    <div className="text">{rowText(m)}</div>
                    <div className="meta">
                      {new Date(m.created_at).toLocaleString()}
                      {pending && <span className="meta-tag">送信中…</span>}
                      {error && (
                        <button className="meta-tag retry" onClick={() => retrySend(m)}>再送</button>
                      )}
                    </div>
                  </div>
                  {/* 自分のメッセージ → 右アバター */}
                  {mine && <img className="avatar me" src={getAvatar(me?.avatar_url)} alt="" />}
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        )}
      </main>

      {/* 入力欄（固定） */}
      <footer className="ftalk-input">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => autoResizeAndSet(e.target.value)}
          placeholder="メッセージを入力（Enterで送信 / Shift+Enterで改行）"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          rows={1}
        />
        <button className="send-btn" onClick={send} disabled={!text.trim()}>送信</button>
      </footer>
    </div>
  );
}
