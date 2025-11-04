'use client';
import { useState } from 'react';
import { getAuth } from 'firebase/auth';

type Props = {
  eventId: 'kyomeikai' | 'ainori';
  title: string;
  description?: string;
};

export default function EventJoinCard({ eventId, title, description }: Props) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'ng'>('idle');
  const [msg, setMsg] = useState<string>('');

  const handleJoin = async () => {
    try {
      setStatus('loading');
      setMsg('');
      const auth = getAuth();
      const idToken = await auth.currentUser?.getIdToken(true);
      if (!idToken) throw new Error('NOT_LOGGED_IN');

      const res = await fetch('/api/attendance/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, event_id: eventId }),
      });
      const json = await res.json();

      if (!res.ok || !json.ok) {
        setStatus('ng');
        setMsg(
          json.error === 'OUT_OF_WINDOW'
            ? '開始±10分のみ出席カウントになります。時間になったらもう一度お試しください。'
            : '参加記録に失敗しました。',
        );
        return;
      }

      setStatus('ok');
      // Zoomへ遷移
      window.location.href = json.zoom_url as string;
    } catch (e: any) {
      setStatus('ng');
      setMsg('エラーが発生しました。再度お試しください。');
    }
  };

  return (
    <div className="event-card">
      <div className="event-title">{title}</div>
      {description && <p className="event-desc">{description}</p>}
      <button className="event-btn" disabled={status === 'loading'} onClick={handleJoin}>
        {status === 'loading' ? '記録中…' : '参加する（Zoomへ）'}
      </button>
      {msg && <div className="event-msg">{msg}</div>}
      <style jsx>{`
        .event-card {
          border: 1px solid #e6e6f0;
          border-radius: 12px;
          padding: 14px;
          background: #fff;
        }
        .event-title {
          font-weight: 700;
          margin-bottom: 6px;
        }
        .event-desc {
          font-size: 14px;
          opacity: 0.8;
          margin: 6px 0 10px;
        }
        .event-btn {
          padding: 10px 14px;
          border-radius: 10px;
          border: 1px solid #d0c4ff;
          background: #f5f0ff;
          cursor: pointer;
        }
        .event-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .event-msg {
          font-size: 12px;
          color: #a00;
          margin-top: 6px;
        }
      `}</style>
    </div>
  );
}
