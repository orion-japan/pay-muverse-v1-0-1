'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import '@/app/kyomeikai/kyomeikai.css';

/* ====== Utils（必要分のみ） ====== */
function parseStartAtJST(iso?: string | null): Date | null {
  if (!iso) return null;
  const s = iso.trim();
  if (/([zZ]|[+\-]\d{2}:\d{2})$/.test(s)) {
    const d = new Date(s); return isNaN(d.getTime()) ? null : d;
  }
  const body = s.includes('T') ? s : s.replace(' ', 'T');
  const withTime = /T\d{2}:\d{2}/.test(body) ? body : `${body}T00:00:00`;
  const d = new Date(`${withTime}+09:00`);
  return isNaN(d.getTime()) ? null : d;
}
function formatDateTimeJST(iso: string) {
  const d = parseStartAtJST(iso); if (!d) return iso;
  const y = d.getFullYear(), m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0'), hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0'); return `${y}/${m}/${day} ${hh}:${mm}`;
}
function openCenteredPopup(url: string, w = 520, h = 740) {
  try {
    const dualLeft = (window.screenLeft ?? window.screenX ?? 0) as number;
    const dualTop = (window.screenTop ?? window.screenY ?? 0) as number;
    const width = (window.innerWidth ?? document.documentElement.clientWidth ?? screen.width) as number;
    const height = (window.innerHeight ?? document.documentElement.clientHeight ?? screen.height) as number;
    const left = dualLeft + (width - w) / 2; const top = dualTop + (height - h) / 2;
    const win = window.open(url, 'zoom-join',
      `noopener,noreferrer,scrollbars=yes,resizable=yes,width=${w},height=${h},left=${left},top=${top}`);
    return win ?? null;
  } catch { return null; }
}
function withParam(url: string, key: string, value: string) {
  const u = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'https://zoom.us');
  u.searchParams.set(key, value); return u.toString();
}

/* ====== 型 ====== */
type NextSchedule = {
  title: string;
  start_at: string;
  duration_min: number;
  page_url?: string;
  meeting_number?: string | number;
  meeting_password?: string;
};

export default function KyomeikaiClient() {
  const router = useRouter();
  const params = useSearchParams();
  const { userCode: userCodeFromCtx } = useAuth();

  const userFromQuery = useMemo(() => params.get('user') || '', [params]);
  const user = (userFromQuery || userCodeFromCtx || '').trim();

  const [schedule, setSchedule] = useState<NextSchedule | null>(null);
  const [username, setUsername] = useState<string>('');
  const [creditBalance, setCreditBalance] = useState<number>(0);
  const [now, setNow] = useState<Date>(new Date());

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);

  // 初期ロード
  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        if (user) {
          const resUser = await fetch('/api/user-info', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ user_code: user }) });
          const uj = await resUser.json().catch(() => ({} as any));
          if (aborted) return;
          setUsername((uj?.click_username || '').toString());
          try {
            const resCredit = await fetch('/api/credits/balance', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ user_code: user }) });
            let balanceNum = 0; if (resCredit.ok) { const cj = await resCredit.json().catch(()=>({} as any)); balanceNum = Number(cj?.balance ?? 0); }
            if (!aborted) setCreditBalance(isFinite(balanceNum) ? balanceNum : 0);
          } catch { if (!aborted) setCreditBalance(0); }
        }
        const resNext = await fetch('/api/kyomeikai/next', { method:'GET' });
        const nextJson = await resNext.json().catch(() => null);
        if (!aborted) setSchedule(nextJson);
      } finally {}
    })();
    return () => { aborted = true; };
  }, [user]);

  const canJoinTime = (s: NextSchedule | null) => {
    if (!s?.start_at || !s?.duration_min) return false;
    const d = parseStartAtJST(s.start_at); if (!d) return false;
    const start = d.getTime(), end = start + s.duration_min * 60 * 1000;
    const open = start - 10 * 60 * 1000; const cur = now.getTime();
    return cur >= open && cur <= end;
  };
  const inAttendWindow = (s: NextSchedule | null) => {
    if (!s?.start_at) return false; const d = parseStartAtJST(s.start_at); if (!d) return false;
    const start = d.getTime(), cur = now.getTime();
    return cur >= start - 10 * 60 * 1000 && cur <= start + 10 * 60 * 1000;
  };

  function buildZoomUrls(s: NextSchedule, displayName: string) {
    if (s.page_url) {
      const web = withParam(s.page_url, 'uname', displayName);
      const app =
        'zoommtg://zoom.us/join?confno=' + (s.meeting_number ?? '') +
        (s.meeting_password ? `&pwd=${encodeURIComponent(s.meeting_password)}` : '') +
        `&uname=${encodeURIComponent(displayName)}`;
      return { webUrl: web, appUrl: app };
    }
    const number = String(s.meeting_number ?? '').replace(/\D/g, '');
    const pwd = s.meeting_password ?? '';
    const baseWeb = `https://zoom.us/j/${number}` + (pwd ? `?pwd=${encodeURIComponent(pwd)}` : '');
    const webUrl = withParam(baseWeb, 'uname', displayName);
    const appUrl =
      `zoommtg://zoom.us/join?action=join&confno=${number}` +
      (pwd ? `&pwd=${encodeURIComponent(pwd)}` : '') +
      `&uname=${encodeURIComponent(displayName)}`;
    return { webUrl, appUrl };
  }

  const handleJoinKyomeikai = async () => {
    const s = schedule;
    if (!user) { alert('ログインしてください。'); return; }
    if (!s) { alert('スケジュールが取得できませんでした。'); return; }
    if (creditBalance <= 0) { alert('クレジット残高がありません。'); return; }

    if (inAttendWindow(s)) {
      try {
        await fetch('/api/attendance/checkin', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ event_id:'kyomeikai', user_code:user }),
        });
      } catch {}
    }

    const displayName = (username || user).trim();
    const { webUrl, appUrl } = buildZoomUrls(s, displayName);
    const pop = openCenteredPopup(webUrl); if (!pop) window.open(webUrl, '_blank', 'noopener,noreferrer');
    try {
      const iframe = document.createElement('iframe'); iframe.style.display = 'none'; iframe.src = appUrl;
      document.body.appendChild(iframe); setTimeout(() => document.body.removeChild(iframe), 1500);
    } catch {}
  };

  return (
    <div className="km-wrap">
      <div className="km-card">
        {/* ← 戻るボタン */}
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => router.back()}
            className="km-button"
            type="button"
            aria-label="イベント一覧に戻る"
            style={{ padding: '6px 12px', fontSize: 14 }}
          >
            ← 戻る
          </button></div>


        <div className="km-card-title">共鳴会</div>
        <div className="km-subtitle">次回のスケジュール</div>

        <div className="km-image-wrap">
          {/* LCP 最適化したいなら next/image へ置換可 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/kyoumei.jpg" alt="共鳴会" className="km-image" />
        </div>

        {schedule ? (
          <div className="km-schedule">
            <div className="km-schedule-row"><span className="km-label">タイトル</span><span className="km-value">{schedule.title}</span></div>
            <div className="km-schedule-row"><span className="km-label">日時</span><span className="km-value">{formatDateTimeJST(schedule.start_at)}</span></div>
            <div className="km-schedule-row"><span className="km-label">所要</span><span className="km-value">{schedule.duration_min} 分</span></div>
            <div className="km-schedule-row km-attend-note">出席カウント対象：<b>開始±10分</b> に「参加する」をクリック</div>
          </div>
        ) : <div className="km-schedule km-muted">予定は未定です。後ほどご確認ください。</div>}

        <div className="km-actions">
          <button
            className={`km-button primary ${(!canJoinTime(schedule) || creditBalance <= 0) ? 'disabled' : ''}`}
            onClick={handleJoinKyomeikai}
            title={!canJoinTime(schedule) ? '開始10分前から入室できます（出席カウントは開始±10分）' : undefined}
            type="button"
          >参加する</button>
        </div>

        {creditBalance <= 0 && (
          <div className="km-note">
            クレジット残高がありません。
            <button className="km-linklike" onClick={() => router.push('/pay')}>チャージ・プランを見る</button>
          </div>
        )}
      </div>
    </div>
  );
}
