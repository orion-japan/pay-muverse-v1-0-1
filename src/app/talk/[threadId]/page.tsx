'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import './thread.css';

/** プロフィール */
type Profile = { user_code: string; name: string | null; avatar_url: string | null };
const avatar = (url: string | null) => {
  const u = (url ?? '').trim();
  if (!u) return '/avatar.png';
  if (u.startsWith('/') || /^https?:\/\//i.test(u) || /^data:image\//i.test(u)) return u;
  return '/avatar.png';
};

export default function PairTalkPage() {
  const router = useRouter();
  const params = useParams<{ threadId: string }>();
  const threadId = decodeURIComponent(params.threadId);

  const auth: any = useAuth();
  const myCode: string | null = auth?.userCode ?? null;

  // 相手コード（threadId = 小さい方__大きい方）
  const peerCode = useMemo(() => {
    if (!myCode) return null;
    const [a, b] = threadId.split('__');
    return a === myCode ? b : a;
  }, [threadId, myCode]);

  const [me, setMe] = useState<Profile | null>(null);
  const [peer, setPeer] = useState<Profile | null>(null);
  const [msgs, setMsgs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // 入力欄
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // 入力オートリサイズ
  const autoResizeAndSet = (v: string) => {
    setText(v);
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
  };

  // プロフ
  useEffect(() => {
    (async () => {
      if (!myCode || !peerCode) return;
      const { data: meP } = await supabase.from('profiles').select('user_code,name,avatar_url').eq('user_code', myCode).maybeSingle();
      const { data: peP } = await supabase.from('profiles').select('user_code,name,avatar_url').eq('user_code', peerCode).maybeSingle();
      setMe(meP as Profile ?? { user_code: myCode, name: null, avatar_url: null });
      setPeer(peP as Profile ?? { user_code: peerCode, name: null, avatar_url: null });
    })();
  }, [myCode, peerCode]);

  // 初期ロード & 既読化
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!threadId || !myCode) return;
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('chats')
          .select('*')
          .eq('thread_id', threadId)
          .order('created_at', { ascending: true });
        if (error) throw error;
        if (!alive) return;
        setMsgs(data ?? []);

        // 自分宛の未読を既読化（read_at を埋める）
        await supabase
          .from('chats')
          .update({ read_at: new Date().toISOString() })
          .eq('thread_id', threadId)
          .eq('receiver_code', myCode)
          .is('read_at', null);
      } catch (e) {
        console.error('[FTalk] init error:', e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [threadId, myCode]);

  // 画面復帰/フォーカス時にも既読化（通知ONの基本）
  useEffect(() => {
    if (!myCode) return;
    const mark = async () => {
      try {
        await supabase
          .from('chats')
          .update({ read_at: new Date().toISOString() })
          .eq('thread_id', threadId)
          .eq('receiver_code', myCode)
          .is('read_at', null);
      } catch {}
    };
    const onFocus = () => mark();
    const onVis = () => { if (document.visibilityState === 'visible') mark(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [threadId, myCode]);

  // Realtime（新着→既読化+通知）
  useEffect(() => {
    if (!threadId) return;
    const ch = supabase
      .channel(`chats:${threadId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chats', filter: `thread_id=eq.${threadId}` },
        async (payload) => {
          const row = payload.new as any;
          setMsgs((prev) => [...prev, row]);

          const fromOtherToMe = row.sender_code !== myCode && row.receiver_code === myCode;

          // 受信したら即既読
          if (fromOtherToMe) {
            try {
              await supabase.from('chats')
                .update({ read_at: new Date().toISOString() })
                .eq('chat_id', row.chat_id);
            } catch {}
          }

          // 通知
          if (fromOtherToMe && 'Notification' in window && Notification.permission === 'granted') {
            new Notification(peer?.name ?? peerCode ?? '新着メッセージ', {
              body: row.message ?? '',
              icon: avatar(peer?.avatar_url),
            });
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [threadId, myCode, peer?.name, peer?.avatar_url, peerCode]);

  // 通知権限
  useEffect(() => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }, []);

  // 末尾へスクロール
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs.length]);

  const isMe = (r: any) => r.sender_code === myCode;

  // 送信
  const send = async () => {
    if (!text.trim() || !myCode || !peerCode) return;
    const body = text.trim();
    setText('');
    if (taRef.current) { taRef.current.style.height = 'auto'; taRef.current.focus(); }

    const optimistic = {
      chat_id: `tmp-${Date.now()}`,
      thread_id: threadId,
      sender_code: myCode,
      receiver_code: peerCode,
      message: body,
      created_at: new Date().toISOString(),
    };
    setMsgs((prev) => [...prev, optimistic]);

    try {
      const { error } = await supabase.from('chats').insert([{
        sender_code: myCode,
        receiver_code: peerCode,
        message: body,
      }]);
      if (error) throw error;
    } catch (e) {
      console.error('[FTalk] send failed:', e);
      setMsgs((prev) => prev.filter((m) => m !== optimistic));
    }
  };

  // QR
  const [qrOpen, setQrOpen] = useState(false);
  const drawQR = async (canvas: HTMLCanvasElement | null) => {
    if (!canvas) return;
    try {
      const QR = await import('qrcode'); // npm i qrcode
      await QR.toCanvas(canvas, `muverse://talk?thread=${threadId}`, { margin: 1, width: 220 });
    } catch {
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      canvas.width = 260; canvas.height = 260;
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,260,260);
      ctx.fillStyle = '#222'; ctx.font = '14px system-ui';
      ctx.fillText('Install "qrcode" to see QR.', 14, 130);
      ctx.fillText(threadId, 14, 152);
    }
  };

  return (
    <div className="ftalk-wrap">
      {/* ヘッダ */}
      <header className="ftalk-head">
        <button className="back" onClick={() => router.back()}>&larr;</button>
        <div className="title">
          <img src={avatar(peer?.avatar_url)} alt="" className="mini" />
          <span className="name">{peer?.name ?? peerCode}</span>
        </div>
        <div />
        <button className="qr" onClick={() => setQrOpen(true)}>Qコード</button>
      </header>

      {/* メッセージ */}
      <main className="ftalk-main">
        {loading ? (
          <div className="empty">読み込み中...</div>
        ) : msgs.length === 0 ? (
          <div className="empty">まだメッセージはありません。</div>
        ) : (
          <div className="timeline">
            {msgs.map((m) => {
              const mine = isMe(m);
              return (
                <div key={`${m.chat_id ?? Math.random()}`} className={`row ${mine ? 'me' : 'you'}`}>
                  {!mine && <img className="avatar" src={avatar(peer?.avatar_url)} alt="" />}
                  <div className="bubble">
                    {!mine && <div className="who">{peer?.name ?? peerCode}</div>}
                    <div className="text">{m.message ?? ''}</div>
                    <div className="meta">{new Date(m.created_at ?? Date.now()).toLocaleString()}</div>
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        )}
      </main>

      {/* 入力欄（タブバーの上に固定） */}
      <footer className="ftalk-input">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => autoResizeAndSet(e.target.value)}
          placeholder="メッセージを入力（Enterで送信 / Shift+Enterで改行）"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          rows={1}
        />
        <button className="send-btn" onClick={send} disabled={!text.trim()}>送信</button>
      </footer>

      {/* Qコード */}
      {qrOpen && (
        <div className="qr-modal" onClick={() => setQrOpen(false)}>
          <div className="qr-card" onClick={(e) => e.stopPropagation()}>
            <h3>Qコード</h3>
            <canvas ref={drawQR as any} />
            <div className="qr-caption">muverse://talk?thread={threadId}</div>
            <button onClick={() => setQrOpen(false)}>閉じる</button>
          </div>
        </div>
      )}
    </div>
  );
}
