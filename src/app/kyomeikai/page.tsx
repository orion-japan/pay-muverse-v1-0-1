'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import './kyomeikai.css'

type NextSchedule = {
  title: string
  start_at: string // ISO（JST想定）
  duration_min: number
  page_url?: string
  meeting_number?: string | number
  meeting_password?: string
}

const AINORI_FALLBACK_URL =
  'https://us04web.zoom.us/j/77118903753?pwd=CVHyhjvmg1FJSb9fnmEhfFMZaa79Ju.1#success'

/** 画面中央に小窓を開く（ブロックされたら null） */
function openCenteredPopup(url: string, w = 520, h = 740) {
  try {
    const dualLeft = (window.screenLeft ?? window.screenX ?? 0) as number
    const dualTop = (window.screenTop ?? window.screenY ?? 0) as number
    const width =
      (window.innerWidth ?? document.documentElement.clientWidth ?? screen.width) as number
    const height =
      (window.innerHeight ?? document.documentElement.clientHeight ?? screen.height) as number
    const left = dualLeft + (width - w) / 2
    const top = dualTop + (height - h) / 2
    const win = window.open(
      url,
      'zoom-join',
      `noopener,noreferrer,scrollbars=yes,resizable=yes,width=${w},height=${h},left=${left},top=${top}`
    )
    return win ?? null
  } catch {
    return null
  }
}

function formatDateTime(iso: string) {
  try {
    const d = new Date(iso)
    const y = d.getFullYear()
    const m = `${d.getMonth() + 1}`.padStart(2, '0')
    const day = `${d.getDate()}`.padStart(2, '0')
    const hh = `${d.getHours()}`.padStart(2, '0')
    const mm = `${d.getMinutes()}`.padStart(2, '0')
    return `${y}/${m}/${day} ${hh}:${mm}`
  } catch {
    return iso
  }
}

/** 祝日判定（API なければ日曜休み扱い） */
async function fetchIsJPHoliday(dateIso: string): Promise<boolean> {
  try {
    const d = new Date(dateIso)
    const y = d.getFullYear()
    const m = `${d.getMonth() + 1}`.padStart(2, '0')
    const day = `${d.getDate()}`.padStart(2, '0')
    const res = await fetch(`/api/jp-holiday?date=${y}-${m}-${day}`)
    if (!res.ok) throw new Error()
    const j = await res.json()
    return !!j?.holiday
  } catch {
    return new Date(dateIso).getDay() === 0 // fallback: 日曜のみ休み
  }
}

/* ===== 月カレンダー（参加日だけ色分け表示・祝日背景） ===== */
function MonthCalendar({ user_code }: { user_code: string }) {
  const [year, setYear] = useState<number>(() => new Date().getFullYear())
  const [month, setMonth] = useState<number>(() => new Date().getMonth() + 1) // 1-12
  const [days, setDays] = useState<Array<{ date: string; events: string[] }>>([])
  const [holidays, setHolidays] = useState<Record<string, string>>({})

  const first = new Date(year, month - 1, 1)
  const last = new Date(year, month, 0)
  const from = `${year}-${String(month).padStart(2, '0')}-01`
  const to = `${year}-${String(month).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`

  useEffect(() => {
    if (!user_code) { setDays([]); return }
    const q = new URLSearchParams({ from, to, user_code })
    fetch(`/api/attendance/days?${q}`)
      .then(r => r.json())
      .then((j) => setDays(Array.isArray(j) ? j : []))
      .catch(() => setDays([]))
  }, [user_code, from, to])

  useEffect(() => {
    fetch(`/api/jp-holidays?year=${year}&month=${month}`)
      .then(r => r.json())
      .then(j => {
        const map: Record<string, string> = {}
        for (const it of j?.items ?? []) map[it.date] = it.name
        setHolidays(map)
      })
      .catch(() => setHolidays({}))
  }, [year, month])

  const eventsByDate = new Map(days.map(d => [d.date, d.events]))

  // グリッド作成
  const cells: Array<{ d: Date; out?: boolean }> = []
  const startDow = first.getDay()
  for (let i = 0; i < startDow; i++) {
    const d = new Date(first)
    d.setDate(1 - (startDow - i))
    cells.push({ d, out: true })
  }
  for (let day = 1; day <= last.getDate(); day++) {
    cells.push({ d: new Date(year, month - 1, day) })
  }
  while (cells.length % 7 !== 0) {
    const d = new Date(last)
    d.setDate(d.getDate() + (cells.length % 7 ? 1 : 0))
    cells.push({ d, out: true })
  }

  return (
    <div className="km-card km-cal">
      <div className="km-card-title">Event参加カレンダー</div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button className="km-button" onClick={() => {
          const d = new Date(year, month - 2, 1); setYear(d.getFullYear()); setMonth(d.getMonth() + 1)
        }}>◀</button>
        <div className="km-cal-head">{year}年 {month}月</div>
        <button className="km-button" onClick={() => {
          const d = new Date(year, month, 1); setYear(d.getFullYear()); setMonth(d.getMonth() + 1)
        }}>▶</button>
        <div style={{ marginLeft: 'auto', fontSize: 12 }}>
          <span className="km-badge kyomeikai">共鳴会</span>{' '}
          <span className="km-badge ainori">瞑想会</span>{' '}
          <span style={{ background: '#fff3f3', padding: '2px 6px', borderRadius: 999, fontSize: 10 }}>祝日</span>
        </div>
      </div>

      <div className="km-cal-grid km-cal-dow">
        <div>日</div><div>月</div><div>火</div><div>水</div><div>木</div><div>金</div><div>土</div>
      </div>

      <div className="km-cal-grid">
        {cells.map((c, i) => {
          const y = c.d.getFullYear()
          const m = String(c.d.getMonth() + 1).padStart(2, '0')
          const day = String(c.d.getDate()).padStart(2, '0')
          const iso = `${y}-${m}-${day}`
          const ev = eventsByDate.get(iso) || []
          const isHoliday = !!holidays[iso]

          const cls = ['km-cal-cell']
          if (c.out) cls.push('km-cal-out')
          if (isHoliday) cls.push('km-cal-holiday')

          return (
            <div key={i} className={cls.join(' ')}>
              <div className="km-cal-date">{c.d.getDate()}</div>
              {ev.length > 0 && (
                <div className="km-cal-badges">
                  {ev.includes('kyomeikai') && <span className="km-badge kyomeikai">共鳴会</span>}
                  {ev.includes('ainori') && <span className="km-badge ainori">瞑想会</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ========== ページ本体 ========== */
function KyomeikaiContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const user = useMemo(() => searchParams.get('user') || '', [searchParams])

  const [checking, setChecking] = useState(true)
  const [plan, setPlan] = useState<string>('')         // users.click_type
  const [username, setUsername] = useState<string>('') // users.click_username
  const [error, setError] = useState<string | null>(null)

  const [schedule, setSchedule] = useState<NextSchedule | null>(null)              // 共鳴会
  const [scheduleAinori, setScheduleAinori] = useState<NextSchedule | null>(null) // 愛祈

  // 時刻（30秒毎更新）
  const [now, setNow] = useState<Date>(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30 * 1000)
    return () => clearInterval(t)
  }, [])

  // 参加履歴バー
  const [rangeFrom, setRangeFrom] = useState<string>(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10)
  })
  const [rangeTo, setRangeTo] = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [history, setHistory] = useState<Array<{ date: string; event_id: string; title?: string }>>([])

  // 祝日キャッシュ（今日が祝日か）
  const [isHolidayToday, setIsHolidayToday] = useState<boolean>(false)
  useEffect(() => { fetchIsJPHoliday(new Date().toISOString()).then(setIsHolidayToday) }, [])

  // 初期ロード
  useEffect(() => {
    let aborted = false
    ;(async () => {
      try {
        setChecking(true); setError(null)
        if (!user) { setPlan('free'); setUsername('') }
        else {
          const resUser = await fetch('/api/user-info', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_code: user })
          })
          const userJson = await resUser.json().catch(() => ({} as any))
          if (aborted) return
          setPlan((userJson?.click_type || '').toString().trim().toLowerCase())
          setUsername((userJson?.click_username || '').toString())
        }
        const [resNext, resAinori] = await Promise.all([
          fetch('/api/kyomeikai/next', { method: 'GET' }),
          fetch('/api/ainori/next', { method: 'GET' }),
        ])
        const nextJson = await resNext.json().catch(() => null)
        const nextA = await resAinori.json().catch(() => null)
        if (!aborted) { setSchedule(nextJson); setScheduleAinori(nextA) }
      } catch (e: any) {
        if (!aborted) setError(e?.message ?? '読み込みに失敗しました')
      } finally {
        if (!aborted) setChecking(false)
      }
    })()
    return () => { aborted = true }
  }, [user])

  // 出席カウント対象：開始±10分
  const inAttendWindow = (s: NextSchedule | null) => {
    if (!s?.start_at) return false
    const start = new Date(s.start_at).getTime()
    const cur = now.getTime()
    return cur >= (start - 10 * 60 * 1000) && cur <= (start + 10 * 60 * 1000)
  }

  // 共鳴会の入室可否
  const canJoinTime = (s: NextSchedule | null) => {
    if (!s?.start_at || !s?.duration_min) return true
    const start = new Date(s.start_at).getTime()
    const end = start + s.duration_min * 60 * 1000
    const open = start - 10 * 60 * 1000
    const cur = now.getTime()
    return cur >= open && cur <= end
  }

  // 愛祈（平日 05:50〜06:30）
  const canJoinAinoriFixed = () => {
    const d = new Date(now)
    const dow = d.getDay()
    if (dow === 0 || isHolidayToday) return false
    const y = d.getFullYear(), m = d.getMonth(), day = d.getDate()
    const open = new Date(y, m, day, 5, 50, 0, 0).getTime()
    const close = new Date(y, m, day, 6, 30, 0, 0).getTime()
    const cur = d.getTime()
    return cur >= open && cur <= close
  }

  // Zoom起動 + 出席記録（共鳴会）
  const handleJoinKyomeikai = async () => {
    const s = schedule
    if (plan === 'free' || !s) return

    const number = String(s.meeting_number ?? '').replace(/\D/g, '')
    const pwd = s.meeting_password ?? ''
    if (!number) { alert('ミーティング番号が取得できませんでした。後ほどお試しください。'); return }

    if (inAttendWindow(s) && user) {
      try {
        await fetch('/api/attendance/checkin', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event_id: 'kyomeikai', user_code: user }),
        })
      } catch {}
    }

    const webUrl = `https://zoom.us/j/${number}` + (pwd ? `?pwd=${encodeURIComponent(pwd)}` : '')
    const appUrl = `zoommtg://zoom.us/join?action=join&confno=${number}` + (pwd ? `&pwd=${encodeURIComponent(pwd)}` : '')
    const pop = openCenteredPopup(webUrl); if (!pop) window.open(webUrl, '_blank', 'noopener,noreferrer')
    try {
      const iframe = document.createElement('iframe'); iframe.style.display = 'none'; iframe.src = appUrl
      document.body.appendChild(iframe); setTimeout(() => document.body.removeChild(iframe), 1500)
    } catch {}
  }

  // Zoom起動 + 出席記録（愛祈）
  const handleJoinAinori = async () => {
    if (!canJoinAinoriFixed()) {
      alert('愛祈は平日6:00開始です（05:50〜06:30のみ参加可能／日曜・祝日休み）')
      return
    }
    if (user) {
      const base = new Date()
      const y = base.getFullYear(), m = base.getMonth(), day = base.getDate()
      const start = new Date(y, m, day, 6, 0, 0, 0).getTime()
      const cur = base.getTime()
      if (cur >= start - 10 * 60 * 1000 && cur <= start + 10 * 60 * 1000) {
        try {
          await fetch('/api/attendance/checkin', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event_id: 'ainori', user_code: user }),
          })
        } catch {}
      }
    }
    const webUrl = AINORI_FALLBACK_URL
    const pop = openCenteredPopup(webUrl); if (!pop) window.open(webUrl, '_blank', 'noopener,noreferrer')
  }

  // 参加履歴の読み込み／DL
  const loadHistory = async () => {
    try {
      if (!user) { setHistory([]); return }
      const q = new URLSearchParams({ from: rangeFrom, to: rangeTo, user_code: user })
      const res = await fetch(`/api/attendance/history?${q.toString()}`)
      const j = await res.json().catch(() => ([] as any))
      setHistory(Array.isArray(j) ? j : [])
    } catch { setHistory([]) }
  }
  const downloadHistory = () => {
    const q = new URLSearchParams({ from: rangeFrom, to: rangeTo, user_code: user })
    window.open(`/api/attendance/export?${q.toString()}`, '_blank', 'noopener,noreferrer')
  }

  // 共鳴会カード
  const ScheduleCard = () => (
    <div className="km-card">
      <div className="km-card-title">共鳴会</div>
      <div className="km-subtitle">次回のスケジュール</div>

      <div className="km-image-wrap">
        <img src="/kyoumei.jpg" alt="共鳴会" className="km-image" />
      </div>

      {schedule ? (
        <div className="km-schedule">
          <div className="km-schedule-row"><span className="km-label">タイトル</span><span className="km-value">{schedule.title}</span></div>
          <div className="km-schedule-row"><span className="km-label">日時</span><span className="km-value">{formatDateTime(schedule.start_at)}</span></div>
          <div className="km-schedule-row"><span className="km-label">所要</span><span className="km-value">{schedule.duration_min} 分</span></div>
          <div className="km-schedule-row km-attend-note">出席カウント対象：<b>開始±10分</b> に「参加する」をクリック</div>
        </div>
      ) : (
        <div className="km-schedule km-muted">予定は未定です。後ほどご確認ください。</div>
      )}

      <div className="km-actions">
        <button
          className={`km-button primary ${(plan === 'free' || !canJoinTime(schedule)) ? 'disabled' : ''}`}
          onClick={handleJoinKyomeikai}
          title={!canJoinTime(schedule) ? '開始10分前から入室できます（出席カウントは開始±10分）' : undefined}
        >参加する</button>
      </div>

      {plan === 'free' && (
        <div className="km-note">
          現在のプランでは共鳴会に参加できません。（<b>free以外参加OK</b>）
          <button className="km-linklike" onClick={() => router.push('/pay')}>プランを見る</button>
        </div>
      )}
    </div>
  )

// 愛祈：カード（固定URL／時間制御／全員OK／画像＋説明）
const AinoriCard: React.FC = () => {
  return (
    <div className="km-card">
      <div className="km-card-title">愛祈AINORI,１０００人</div>

      {/* 画像 */}
      <div className="km-image-wrap">
        <img src="/ainori1.jpeg" alt="愛祈AINORI" className="km-image" />
      </div>

      {/* スケジュール（APIが未定でも表示が崩れないよう2通り） */}
      {scheduleAinori ? (
        <div className="km-schedule">
          <div className="km-schedule-row">
            <span className="km-label">タイトル</span>
            <span className="km-value">{scheduleAinori.title}</span>
          </div>
          <div className="km-schedule-row">
            <span className="km-label">開始（固定）</span>
            <span className="km-value">毎朝 6:00（平日）</span>
          </div>
          <div className="km-schedule-row">
            <span className="km-label">OPEN時間</span>
            <span className="km-value">05:50〜06:30（JST）</span>
          </div>
          <div className="km-schedule-row">
            <span className="km-label">休止日</span>
            <span className="km-value">日曜・祝日</span>
          </div>
          <div className="km-schedule-row km-attend-note">
            出席カウント対象：<b>開始±10分</b> に「参加する」をクリック
          </div>
        </div>
      ) : (
        <div className="km-schedule">
          <div className="km-schedule-row">
            <span className="km-label">開始（固定）</span>
            <span className="km-value">毎朝 6:00（平日）</span>
          </div>
          <div className="km-schedule-row">
            <span className="km-label">OPEN時間</span>
            <span className="km-value">05:50〜06:30（JST）</span>
          </div>
          <div className="km-schedule-row">
            <span className="km-label">休止日</span>
            <span className="km-value">日曜・祝日</span>
          </div>
          <div className="km-schedule-row km-attend-note">
            出席カウント対象：<b>開始±10分</b> に「参加する」をクリック
          </div>
        </div>
      )}

      {/* URLはリンク無しのテキスト＋コピー */}
      <div className="km-description" style={{ marginTop: 12 }}>
        <p><b>瞑想会のURL（固定・表示のみ）</b></p>

        <div
          className="km-url-row"
          style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
        >
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
            onClick={() => {
              navigator.clipboard?.writeText(AINORI_FALLBACK_URL)
            }}
            style={{ padding: '4px 8px', fontSize: 12, lineHeight: 1.2 }}
            title="URLをクリップボードにコピー"
          >
            コピー
          </button>
        </div>

        <p style={{ marginTop: 6 }}>
          ※ 平日のみ 05:50〜06:30（JST）にOPEN／日曜・祝日はお休み。<br />
          ※ 瞑想会は参加資格なし、<b>全員参加OK</b>です。
        </p>
      </div>

      <div className="km-actions">
        <button
          className={`km-button primary ${!canJoinAinoriFixed() ? 'disabled' : ''}`}
          onClick={handleJoinAinori}
          title="平日05:50〜06:30（JST）のみ参加可能／日曜・祝日休み"
          type="button"
        >
          参加する
        </button>
      </div>
    </div>
  )
}


  // 参加履歴（テーブル）
  const CalendarBar = () => (
    <div className="km-card">
      <div className="km-card-title">参加履歴カレンダー</div>
      <div className="km-range">
        <label className="km-label-inline">期間</label>
        <input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
        <span style={{ padding: '0 6px' }}>〜</span>
        <input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
        <button className="km-button" onClick={loadHistory} style={{ marginLeft: 8 }}>表示</button>
        <button className="km-button" onClick={downloadHistory} style={{ marginLeft: 8 }}>ダウンロード</button>
      </div>

      <div className="km-history">
        {user ? (
          history.length ? (
            <table className="km-table">
              <thead><tr><th>日付</th><th>イベント</th><th>タイトル</th></tr></thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i}><td>{h.date}</td><td>{h.event_id}</td><td>{h.title ?? '-'}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="km-muted">期間内の参加履歴はありません。</div>
          )
        ) : (
          <div className="km-muted">参加履歴を表示するにはログインしてください。</div>
        )}
      </div>
    </div>
  )

  if (checking) {
    return <div className="km-fullcenter km-muted">読み込み中…</div>
  }

  return (
    <div className="km-wrap">
      <header className="km-header">
        <h1 className="km-title">Event参加カレンダー</h1>
        {username ? <div className="km-user">ようこそ、{username} さん</div> : null}
      </header>

      <main className="km-main">
        {/* 月カレンダー（参加日だけ表示・色分け・祝日対応） */}
        <MonthCalendar user_code={user || ''} />

        {/* 参加履歴（期間指定テーブル + DL） */}
        <CalendarBar />

        {/* 共鳴会カード */}
        <ScheduleCard />

        {/* 愛祈カード */}
        <AinoriCard />
      </main>
    </div>
  )
}

export default function KyomeikaiPage() {
  return (
    <div className="km-root">
      <Suspense fallback={<div className="km-fullcenter">読み込み中...</div>}>
        <KyomeikaiContent />
      </Suspense>
    </div>
  )
}
