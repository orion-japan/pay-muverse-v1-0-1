'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import '../styles/dashboard.css'
import LoginModal from '../components/LoginModal'
import { useAuth } from '@/context/AuthContext'
import AppModal from '@/components/AppModal'
import { FileContentProvider } from '@/lib/content.file'
import type { HomeContent } from '@/lib/content'
import { redirectToMuAi } from '../utils/redirectToMuAi' // ★ 追加
import { auth } from '@/lib/firebase'


export default function DashboardPage() {
  const [content, setContent] = useState<HomeContent | null>(null)
  const [current, setCurrent] = useState(0)
  const { user, userCode } = useAuth()
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false)
  const router = useRouter()

  // LIVEモーダル状態
  const [liveModalOpen, setLiveModalOpen] = useState(false)
  const [liveModalText, setLiveModalText] = useState('')

  useEffect(() => {
    FileContentProvider.getHomeContent().then(setContent)
  }, [])

  useEffect(() => {
    if (!content?.heroImages?.length) return
    const interval = setInterval(() => {
      setCurrent((prev) => (prev + 1) % content.heroImages.length)
    }, 4000)
    return () => clearInterval(interval)
  }, [content])

  // 並び：Mu_AI / 共鳴会 / 共鳴会 LIVE / プラン
  const menuItems: { title: string; link: string; img: string; alt: string }[] = [
    { title: 'Mu_AI', link: '/mu_full', img: '/mu_ai.png', alt: 'Mu_AI' },
    { title: '共鳴会', link: '/kyomeikai', img: '/kyoumai.png', alt: '共鳴会' },
    { title: '配信', link: '/kyomeikai/live', img: '/live.png', alt: '共鳴会LIVE' },
    { title: 'プラン', link: '/pay', img: '/mu_card.png', alt: 'プラン' },
  ]
  const tileVariants = ['tile--mu', 'tile--kyomei', 'tile--live', 'tile--plan'] as const

  // userクエリが必要なページ
  const needsUserParam = new Set<string>(['/mu_ai', '/kyomeikai', '/kyomeikai/live'])

  const handleClick = async (link: string) => {
    if (!user || !userCode) {
      setIsLoginModalOpen(true)
      return
    }

// Mu_AI はFirebaseトークンで自動ログイン遷移
if (link === '/mu_full') {
  try {
    const currentUser = auth.currentUser
    if (!currentUser) {
      setIsLoginModalOpen(true)
      return
    }

    // Firebase IDトークン取得
    const token = await currentUser.getIdToken()

    // MU側のエンドポイントにトークン送信
    const muBase = process.env.NEXT_PUBLIC_MU_AI_BASE_URL || 'https://mu-ui-v1-0-5.vercel.app'
    const url = `${muBase.replace(/\/$/, '')}/api/get-user-info`

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }) // ★ user_codeではなくidToken
    })

    if (!res.ok) {
      console.error('MU側への認証リクエスト失敗')
      return
    }

    const data = await res.json()
    console.log('MU側ユーザー情報:', data)

    // 認証成功後にページ遷移
    router.push('/mu_full')
  } catch (err) {
    console.error('MU側遷移処理中にエラー:', err)
  }
  return
}



    // LIVEページだけ事前チェック
    if (link === '/kyomeikai/live') {
      try {
        const r = await fetch('/api/kyomeikai/live/status', { cache: 'no-store' })
        const j = await r.json()
        if (!j?.is_live) {
          setLiveModalText('現在LIVE配信は行われていません。開始までお待ちください。')
          setLiveModalOpen(true)
          return
        }
        const url = j?.room ? `${link}?room=${encodeURIComponent(j.room)}` : link
        router.push(url)
        return
      } catch {
        setLiveModalText('配信状況を確認できませんでした。時間をおいて再度お試しください。')
        setLiveModalOpen(true)
        return
      }
    }

    const linkWithParam =
      needsUserParam.has(link) ? `${link}?user=${encodeURIComponent(userCode)}` : link
    router.push(linkWithParam)
  }

  const images = content?.heroImages ?? []
  const notices = content?.notices ?? []

  return (
    <div
      className="dashboard-wrapper"
      onClick={() => {
        if (!user) setIsLoginModalOpen(true)
      }}
    >
      {/* 本文 */}
      <div style={{ paddingTop: '2.5px' }}>
        <section className="slider-container">
          {images.map((img, index) => (
            <img
              key={img}
              src={img}
              alt={`Muverse Banner ${index}`}
              className={`slider-image ${index === current ? 'active' : ''}`}
              draggable={false}
            />
          ))}
        </section>

        <section className="notice-section">
          <h2 className="notice-title">📢 お知らせ</h2>
          {notices.map((n) => (
            <div key={n.id} className="notice-item">
              {n.text}
            </div>
          ))}
        </section>

        <section className="tile-grid">
          {menuItems.map((item, idx) => (
            <div
              key={item.title}
              className={`tile ${tileVariants[idx]} ${!user ? 'disabled' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                handleClick(item.link)
              }}
            >
              <div className="tile-inner">
                <div className="tile-icon">
                  <img
                    src={item.img}
                    alt={item.alt}
                    className="tile-icon-img"
                    draggable={false}
                  />
                </div>
                <div className="tile-label">{item.title}</div>
              </div>
            </div>
          ))}
        </section>
      </div>

      <LoginModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onLoginSuccess={() => setIsLoginModalOpen(false)}
      />

      {/* LIVE用モーダル */}
      <AppModal
        open={liveModalOpen}
        title="共鳴会 LIVE"
        onClose={() => setLiveModalOpen(false)}
        primaryText="OK"
      >
        {liveModalText}
      </AppModal>
    </div>
  )
}
