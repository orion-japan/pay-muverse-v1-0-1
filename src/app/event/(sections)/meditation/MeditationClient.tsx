// app/event/(sections)/meditation/MeditationClient.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import '@/app/kyomeikai/kyomeikai.css';

const AINORI_FALLBACK_URL =
  'https://us04web.zoom.us/j/77118903753?pwd=CVHyhjvmg1FJSb9fnmEhfFMZaa79Ju.1#success';

async function fetchIsJPHoliday(dateIso: string): Promise<boolean> {
  const d = new Date(dateIso);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');

  try {
    const res = await fetch(`/api/jp-holiday?date=${y}-${m}-${day}`);
    if (!res.ok) throw new Error('fallback');
    const j = await res.json();
    return !!j?.holiday;
  } catch {
    try {
      const res2 = await fetch(`/api/jp-holidays?date=${y}-${m}-${day}`);
      if (!res2.ok) throw new Error('fail');
      const j2 = await res2.json();
      return !!j2?.holiday;
    } catch {
      return new Date(dateIso).getDay() === 0; // 日曜フォールバック
    }
  }
}

export default function MeditationClient() {
  const router = useRouter();
  const params = useSearchParams();
  const { userCode: userCodeFromCtx } = useAuth();

  // useSearchParams() は参照が変わることがあるので get() の結果だけをメモ化
  const userFromQuery = useMemo(() => params.get('user') || '', [params]);
  const user = (userFromQuery || userCodeFromCtx || '').trim();

  const [isHolidayToday, setIsHolidayToday] = useState<boolean>(false);
  const [now, setNow] = useState<Date>(new Date());

  useEffect(() => {
    fetchIsJPHoliday(new Date().toISOString()).then(setIsHolidayToday);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // 参加可能時間：平日 05:50〜06:10（JST）
  const canJoinAinoriFixed = () => {
    const d = new Date(now);
    const dow = d.getDay();
    if (dow === 0 || isHolidayToday) return false; // 日曜・祝日NG
    const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
    const open = new Date(y, m, day, 5, 50, 0, 0).getTime();
    const close = new Date(y, m, day, 6, 10, 0, 0).getTime();
    const cur = d.getTime();
    return cur >= open && cur <= close;
  };

  const handleJoinAinori = async () => {
    if (!canJoinAinoriFixed()) {
      alert('愛祈は平日6:00開始です（05:50〜06:10のみ参加可能／日曜・祝日休み）');
      return;
    }

    if (user) {
      const base = new Date();
      const y = base.getFullYear(), m = base.getMonth(), day = base.getDate();
      const start = new Date(y, m, day, 6, 0, 0, 0).getTime();
      const cur = base.getTime();

      // 開始±10分でチェックイン
      if (cur >= start - 10 * 60 * 1000 && cur <= start + 10 * 60 * 1000) {
        try {
          await fetch('/api/attendance/checkin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event_id: 'ainori', user_code: user }),
          });
        } catch {
          // 失敗は無視（参加自体は続行）
        }
      }
    }

    const win = window.open(AINORI_FALLBACK_URL, '_blank', 'noopener,noreferrer');
    if (!win) alert('ポップアップがブロックされました。リンクを許可してください。');
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
          </button>
          <div className="km-card-title" style={{ margin: 0 }}>愛祈AINORI,１０００人</div>
        </div>

        <div className="km-image-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/ainori1.jpeg" alt="愛祈AINORI" className="km-image" />
        </div>

        <div className="km-schedule">
          <div className="km-schedule-row">
            <span className="km-label">開始（固定）</span>
            <span className="km-value">毎朝 6:00（平日）</span>
          </div>
          <div className="km-schedule-row">
            <span className="km-label">OPEN時間</span>
            <span className="km-value">05:50〜06:10（JST）</span>
          </div>
          <div className="km-schedule-row">
            <span className="km-label">休止日</span>
            <span className="km-value">日曜・祝日</span>
          </div>
          <div className="km-schedule-row km-attend-note">
            出席カウント対象：<b>開始±10分</b> に「参加する」をクリック
          </div>
        </div>

        <div className="km-description" style={{ marginTop: 12 }}>
          <p><b>瞑想会のURL（固定・表示のみ）</b></p>
          <div className="km-url-row" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              className="km-url"
              style={{
                wordBreak: 'break-all',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                background: '#f6f6ff',
                border: '1px solid #e6e6f9',
                borderRadius: 8,
                padding: '6px 8px',
              }}
            >
              {AINORI_FALLBACK_URL}
            </span>
            <button
              className="km-button km-button-tiny"
              type="button"
              onClick={() => { navigator.clipboard?.writeText(AINORI_FALLBACK_URL); }}
              style={{ padding: '4px 8px', fontSize: 12, lineHeight: 1.2 }}
              title="URLをコピー"
            >
              コピー
            </button>
          </div>
          <p style={{ marginTop: 6 }}>
            ※ 平日のみ 05:50〜06:10（JST）にOPEN／日曜・祝日休み。<br />
            ※ 瞑想会は参加資格なし、<b>全員参加OK</b>です。
          </p>
        </div>

        <div className="km-actions">
          <button
            className={`km-button primary ${!canJoinAinoriFixed() ? 'disabled' : ''}`}
            onClick={handleJoinAinori}
            title="平日05:50〜06:10（JST）のみ参加可能／日曜・祝日休み"
            type="button"
          >
            参加する
          </button>
        </div>
      </div>
    </div>
  );
}
