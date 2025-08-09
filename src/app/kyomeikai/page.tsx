'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import './kyomeikai.css'

type NextSchedule = {
  title: string
  start_at: string // ISO（JST想定）
  duration_min: number
  reservation_url?: string
  page_url?: string            // ★ 参加ページURL（/kyomeikai/jitsi など）
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
  const [showMeeting, setShowMeeting] = useState(false)       // 参加ボタンクリック後にiframe表示

  // ★ 参加URL（APIの page_url を基に生成）
  const [joinUrl, setJoinUrl] = useState<string>('')

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

        // 2) 次回スケジュール取得（Zoom直取りAPI or 代替）
        const resNext = await fetch('/api/kyomeikai/next', { method: 'GET' })
        const nextJson = await resNext.json().catch(() => null)
        if (!aborted) {
          setSchedule(nextJson)
          // デバッグ用
          // console.log('Next schedule:', nextJson)
        }
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

  // ★ 参加ボタン押下で joinUrl を組み立てて iframe 表示
  // ★ 参加ボタン押下で joinUrl を組み立てて iframe 表示
const handleJoin = () => {
  if (plan === 'free') return

  // 例: kyomeikai-20250809-abc12 など毎回違う名前にして誰でも先頭で入室＝モデレーター化
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`
  const rand = Math.random().toString(36).slice(2,7)
  const room = `kyomeikai-${ymd}-${rand}`

  const base = schedule?.page_url || '/kyomeikai/jitsi'
  const url = `${base}?room=${encodeURIComponent(room)}&name=${encodeURIComponent(username || 'Guest')}`

  setJoinUrl(url)
  setShowMeeting(true)
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

  if (showMeeting && plan !== 'free') {
    // 参加ボタン後に会議を埋め込み（外部のWeb SDKページ or 既存ページをiframe表示）
    return (
      <iframe
        src={joinUrl}  // ★ APIのpage_urlベース＋user/nameを付与
        className="km-iframe"
        allow="camera; microphone; fullscreen; clipboard-read; clipboard-write"
      />
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
