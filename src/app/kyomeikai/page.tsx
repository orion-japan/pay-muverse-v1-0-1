'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import './kyomeikai.css'

type NextSchedule = {
  title: string
  start_at: string // ISO（JST想定）
  duration_min: number
  page_url?: string
  // Zoom参加用（APIから返す）
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

function KyomeikaiContent() {
  const searchParams = useSearchParams()
  const router = useRouter()

  // 既存仕様：?user= として受け取る（useAuthに切替も可）
  const user = useMemo(() => searchParams.get('user') || '', [searchParams])

  // 画面状態
  const [checking, setChecking] = useState(true)
  const [plan, setPlan] = useState<string>('')                // users.click_type
  const [username, setUsername] = useState<string>('')        // users.click_username
  const [error, setError] = useState<string | null>(null)

  const [schedule, setSchedule] = useState<NextSchedule | null>(null)            // 共鳴会
  const [scheduleAinori, setScheduleAinori] = useState<NextSchedule | null>(null) // 愛祈

  // ★ 参加可能時間のための現在時刻（30秒おきに更新）
  const [now, setNow] = useState<Date>(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30 * 1000)
    return () => clearInterval(t)
  }, [])

  // 初期ロード：ユーザー判定と次回スケジュール取得
  useEffect(() => {
    let aborted = false
    ;(async () => {
      try {
        setChecking(true)
        setError(null)

        // --- ユーザーがいなくてもスケジュールは取得する ---
        if (!user) {
          // 未ログインは free 扱い（参加は不可）で続行
          setPlan('free')
          setUsername('')
        } else {
          // 1) ユーザープラン判定
          const resUser = await fetch('/api/user-info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_code: user }),
          })
          const userJson = await resUser.json().catch(() => ({} as any))
          if (aborted) return
          const planType = (userJson?.click_type || '').toString().trim().toLowerCase()
          const uname = (userJson?.click_username || '').toString()
          setPlan(planType)
          setUsername(uname)
        }

        // 2) 次回スケジュール取得（共鳴会 / 愛祈）
        const [resNext, resAinori] = await Promise.all([
          fetch('/api/kyomeikai/next', { method: 'GET' }),
          fetch('/api/ainori/next', { method: 'GET' }),
        ])
        const nextJson = await resNext.json().catch(() => null)
        const nextA = await resAinori.json().catch(() => null)
        if (!aborted) {
          setSchedule(nextJson)
          setScheduleAinori(nextA)
        }
      } catch (e: any) {
        if (!aborted) setError(e?.message ?? '読み込みに失敗しました')
      } finally {
        if (!aborted) setChecking(false)
      }
    })()
    return () => { aborted = true }
  }, [user])

  // ★ 出席カウント対象時間：開始の「±10分」
  const inAttendWindow = (s: NextSchedule | null) => {
    if (!s?.start_at) return false
    const start = new Date(s.start_at).getTime()
    const cur = now.getTime()
    const windowStart = start - 10 * 60 * 1000
    const windowEnd   = start + 10 * 60 * 1000
    return cur >= windowStart && cur <= windowEnd
  }

  // ★ 入室可否：UI上の「参加する」活性条件
  //   - free 以外
  //   - 「開始10分前〜終了時刻」までは押せる（入室自体は許容）
  const canJoinTime = (s: NextSchedule | null) => {
    if (!s?.start_at || !s?.duration_min) return true // 予定未定なら許可
    const start = new Date(s.start_at).getTime()
    const end = start + s.duration_min * 60 * 1000
    const open = start - 10 * 60 * 1000
    const cur = now.getTime()
    return cur >= open && cur <= end
  }

  // ★ Zoom起動 + 出席記録（共鳴会）
  const handleJoinKyomeikai = async () => {
    const s = schedule
    if (plan === 'free' || !s) return

    const number = String(s.meeting_number ?? '').replace(/\D/g, '')
    const pwd = s.meeting_password ?? ''

    if (!number) {
      alert('ミーティング番号が取得できませんでした。後ほどお試しください。')
      return
    }

    // 出席記録（開始±10分の時のみ）
    if (inAttendWindow(s) && user) {
      try {
        await fetch('/api/attendance/checkin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event_id: 'kyomeikai', user_code: user }),
        })
      } catch {}
    }

    const webUrl =
      `https://zoom.us/j/${number}` + (pwd ? `?pwd=${encodeURIComponent(pwd)}` : '')
    const appUrl =
      `zoommtg://zoom.us/join?action=join&confno=${number}` +
      (pwd ? `&pwd=${encodeURIComponent(pwd)}` : '')

    const pop = openCenteredPopup(webUrl)
    if (!pop) window.open(webUrl, '_blank', 'noopener,noreferrer')

    try {
      const iframe = document.createElement('iframe')
      iframe.style.display = 'none'
      iframe.src = appUrl
      document.body.appendChild(iframe)
      setTimeout(() => document.body.removeChild(iframe), 1500)
    } catch {}
  }

  // ★ Zoom起動 + 出席記録（愛祈）
  const handleJoinAinori = async () => {
    const s = scheduleAinori
    if (plan === 'free' || !s) return

    // 出席記録（開始±10分の時のみ）
    if (inAttendWindow(s) && user) {
      try {
        await fetch('/api/attendance/checkin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event_id: 'ainori', user_code: user }),
        })
      } catch {}
    }

    // ミーティング番号があればそれを、無ければ直リンク
    const number = String(s.meeting_number ?? '').replace(/\D/g, '')
    const pwd = s.meeting_password ?? ''
    const webUrl = number
      ? `https://zoom.us/j/${number}` + (pwd ? `?pwd=${encodeURIComponent(pwd)}` : '')
      : AINORI_FALLBACK_URL
    const appUrl = number
      ? `zoommtg://zoom.us/join?action=join&confno=${number}` +
        (pwd ? `&pwd=${encodeURIComponent(pwd)}` : '')
      : ''

    const pop = openCenteredPopup(webUrl)
    if (!pop) window.open(webUrl, '_blank', 'noopener,noreferrer')

    if (appUrl) {
      try {
        const iframe = document.createElement('iframe')
        iframe.style.display = 'none'
        iframe.src = appUrl
        document.body.appendChild(iframe)
        setTimeout(() => document.body.removeChild(iframe), 1500)
      } catch {}
    }
  }

  // 共鳴会：スケジュールカード（予約ボタンなし）
  const ScheduleCard = () => (
    <div className="km-card">
      <div className="km-card-title">次回のスケジュール</div>
      {schedule ? (
        <div className="km-schedule">
          <div className="km-schedule-row">
            <span className="km-label">タイトル</span>
            <span className="km-value">{schedule.title}</span>
          </div>
          <div className="km-schedule-row">
            <span className="km-label">日時</span>
            <span className="km-value">{formatDateTime(schedule.start_at)}</span>
          </div>
          <div className="km-schedule-row">
            <span className="km-label">所要</span>
            <span className="km-value">{schedule.duration_min} 分</span>
          </div>
          <div className="km-schedule-row km-attend-note">
            出席カウント対象：<b>開始±10分</b> に「参加する」をクリック
          </div>
        </div>
      ) : (
        <div className="km-schedule km-muted">予定は未定です。後ほどご確認ください。</div>
      )}
      <div className="km-actions">
        {/* 参加ボタンのみ */}
        <button
          className={`km-button primary ${(plan === 'free' || !canJoinTime(schedule)) ? 'disabled' : ''}`}
          onClick={handleJoinKyomeikai}
          title={!canJoinTime(schedule) ? '開始10分前から入室できます（出席カウントは開始±10分）' : undefined}
        >
          参加する
        </button>
      </div>

      {plan === 'free' && (
        <div className="km-note">
          現在のプランでは共鳴会に参加できません。
          <button className="km-linklike" onClick={() => router.push('/pay')}>プランを見る</button>
        </div>
      )}
    </div>
  )

  // 愛祈：カード（予約ボタンなし、説明付き）
  const AinoriCard = () => (
    <div className="km-card">
      <div className="km-card-title">愛祈AINORI,１０００人</div>
      {scheduleAinori ? (
        <div className="km-schedule">
          <div className="km-schedule-row">
            <span className="km-label">タイトル</span>
            <span className="km-value">{scheduleAinori.title}</span>
          </div>
          <div className="km-schedule-row">
            <span className="km-label">日時</span>
            <span className="km-value">{formatDateTime(scheduleAinori.start_at)}</span>
          </div>
          <div className="km-schedule-row">
            <span className="km-label">所要</span>
            <span className="km-value">{scheduleAinori.duration_min} 分</span>
          </div>
          <div className="km-schedule-row km-attend-note">
            出席カウント対象：<b>開始±10分</b> に「参加する」をクリック
          </div>
        </div>
      ) : (
        <div className="km-schedule km-muted">予定は未定です。後ほどご確認ください。</div>
      )}

      {/* 説明 */}
      <div className="km-description" style={{ marginTop: 12 }}>
        <p><b>『ズーム瞑想会　(愛祈AINORI,１０００人)』のご案内</b></p>
        <p>ー集合意識を介して日本を変えるー</p>
        <p>
          ルート1％の法則ってご存知ですか？ アメリカで集団瞑想をする人が人口のルート1％の1,750人
          （アメリカの人口3億人の１％＝300万人。ルート300万人＝1,750人）に達した途端、全米での殺人件数・レイプ件数・交通事故数などが著しく減少したのです。
          その驚くべき結果が２年前に発表されています（Orme-Johnson et. Al, World Journal of Social Science, 9, 2, 2022. https://doi.org/10.5430/wjss.v9n2p1）。
          これは集団で瞑想することにより、そのエネルギーの波動が集合意識を変容させたものと解釈できます。
        </p>
        <p>
          日本でのルート1％は１,０００人となります（日本の人口１億人の１％＝１00万人。ルート１００万人＝１,０００人）。
          日本の現状や未来に不満や不安を感じつつも、一人では何もできないと諦めておられる方も多いことでしょう。
          一人一人は無力でも、１,０００人が集まって同じ時間に瞑想することで、閉塞した日本を変革させることができるのです。
        </p>
      </div>

      <div className="km-actions">
        <button
          className={`km-button primary ${(plan === 'free' || !canJoinTime(scheduleAinori)) ? 'disabled' : ''}`}
          onClick={handleJoinAinori}
          title={!canJoinTime(scheduleAinori) ? '開始10分前から入室できます（出席カウントは開始±10分）' : undefined}
        >
          参加する
        </button>
      </div>

      {plan === 'free' && (
        <div className="km-note">
          現在のプランでは参加できません。
          <button className="km-linklike" onClick={() => router.push('/pay')}>プランを見る</button>
        </div>
      )}
    </div>
  )

  if (checking) {
    return <div className="km-fullcenter km-muted">読み込み中…</div>
  }

  return (
    <div className="km-wrap">
      <header className="km-header">
        <h1 className="km-title">共鳴会</h1>
        {username ? <div className="km-user">ようこそ、{username} さん</div> : null}
      </header>

      <main className="km-main">
        {/* 共鳴会（既存のまま／予約ボタンのみ削除） */}
        <ScheduleCard />
        {/* ↓ 追加：愛祈AINORI,１０００人 */}
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
