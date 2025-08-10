'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import './kyomeikai.css'

type NextSchedule = {
  title: string
  start_at: string // ISO（JST想定）
  duration_min: number
  reservation_url?: string
  page_url?: string
  // Zoom参加用（APIから返す）
  meeting_number?: string | number
  meeting_password?: string
}

/** 画面中央に小窓を開く（ブロックされたら null） */
function openCenteredPopup(url: string, w = 520, h = 740) {
  try {
    const dualLeft = (window.screenLeft ?? window.screenX ?? 0) as number
    const dualTop = (window.screenTop ?? window.screenY ?? 0) as number
    const width =
      (window.innerWidth ??
        document.documentElement.clientWidth ??
        screen.width) as number
    const height =
      (window.innerHeight ??
        document.documentElement.clientHeight ??
        screen.height) as number
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

  const [schedule, setSchedule] = useState<NextSchedule | null>(null)

  // ★ 参加可能時間のための現在時刻（1分おきに更新）
  const [now, setNow] = useState<Date>(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60 * 1000)
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

        // 2) 次回スケジュール取得
        const resNext = await fetch('/api/kyomeikai/next', { method: 'GET' })
        const nextJson = await resNext.json().catch(() => null)
        if (!aborted) setSchedule(nextJson)
      } catch (e: any) {
        if (!aborted) setError(e?.message ?? '読み込みに失敗しました')
      } finally {
        if (!aborted) setChecking(false)
      }
    })()
    return () => { aborted = true }
  }, [user])

  // ★ 参加可能時間判定（開始5分前〜終了まで）
  const canJoinTime = (() => {
    if (!schedule?.start_at || !schedule?.duration_min) return true // 予定未定なら許可
    const start = new Date(schedule.start_at).getTime()
    const end = start + schedule.duration_min * 60 * 1000
    const open = start - 5 * 60 * 1000
    const cur = now.getTime()
    return cur >= open && cur <= end
  })()

  // ★ Zoomをポップアップで開く + アプリ起動を試みる（フォールバック：新規タブ）
  const handleJoin = () => {
    if (plan === 'free' || !schedule) return

    const number = String(schedule.meeting_number ?? '').replace(/\D/g, '')
    const pwd = schedule.meeting_password ?? ''

    if (!number) {
      alert('ミーティング番号が取得できませんでした。後ほどお試しください。')
      return
    }

    // Web 参加URL（まずポップアップで開く）
    const webUrl =
      `https://zoom.us/j/${number}` +
      (pwd ? `?pwd=${encodeURIComponent(pwd)}` : '')

    // ネイティブアプリ Deep Link（失敗してもユーザーの画面遷移はしない）
    const appUrl =
      `zoommtg://zoom.us/join?action=join&confno=${number}` +
      (pwd ? `&pwd=${encodeURIComponent(pwd)}` : '')

    // 1) ポップアップでWeb参加画面を開く（ブロック時は新規タブ）
    const pop = openCenteredPopup(webUrl)
    if (!pop) window.open(webUrl, '_blank', 'noopener,noreferrer')

    // 2) 可能ならアプリ起動を試す（隠しiframeで、失敗しても画面遷移なし）
    try {
      const iframe = document.createElement('iframe')
      iframe.style.display = 'none'
      iframe.src = appUrl
      document.body.appendChild(iframe)
      setTimeout(() => document.body.removeChild(iframe), 1500)
    } catch {
      /* no-op */
    }
  }

  // スケジュールカード
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
        </div>
      ) : (
        <div className="km-schedule km-muted">予定は未定です。後ほどご確認ください。</div>
      )}
      <div className="km-actions">
        {/* 予約は誰でもOK（URLがあれば） */}
        {schedule?.reservation_url ? (
          <a className="km-button ghost" href={schedule.reservation_url} target="_blank" rel="noreferrer">
            予約する
          </a>
        ) : (
          <button className="km-button ghost" onClick={() => router.push('/reserve')}>
            予約する
          </button>
        )}
        {/* 参加ボタン：free以外 かつ 時間内のみ有効 */}
        <button
          className={`km-button primary ${(plan === 'free' || !canJoinTime) ? 'disabled' : ''}`}
          onClick={handleJoin}
          title={!canJoinTime ? '開始5分前から入室できます' : undefined}
        >
          参加する
        </button>
      </div>

      {/* freeの人向け案内（自動遷移はしない） */}
      {plan === 'free' && (
        <div className="km-note">
          現在のプランでは共鳴会に参加できません。
          <button className="km-linklike" onClick={() => router.push('/pay')}>プランを見る</button>
        </div>
      )}
    </div>
  )

  // 説明セクション
  const Description = () => (
    <div className="km-card">
      <div className="km-card-title">共鳴会とは</div>
      <div className="km-description">
        <p>
          共鳴会は、Muverseの「意図×場の共鳴」を体験するオンライン・セッションです。
          初めての方は「予約する」から日程調整を、継続利用の方は開始時刻に「参加する」から入室できます。
        </p>
        <ul>
          <li>参加にはマイク／カメラの許可が必要です（ブラウザからの参加可）。</li>
          <li>スマホ参加の場合は、通信環境の良い場所でご利用ください。</li>
          <li>開始5分前までに入室をおすすめします。</li>
        </ul>
      </div>
    </div>
  )

  if (checking) {
    return (
      <div className="km-fullcenter km-muted">読み込み中…</div>
    )
  }

  return (
    <div className="km-wrap">
      <header className="km-header">
        <h1 className="km-title">共鳴会</h1>
        {username ? <div className="km-user">ようこそ、{username} さん</div> : null}
      </header>

      <main className="km-main">
        <ScheduleCard />
        <Description />
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
