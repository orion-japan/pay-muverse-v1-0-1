'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import '../styles/dashboard.css'
import LoginModal from '../components/LoginModal'
import { useAuth } from '@/context/AuthContext'
import AppModal from '@/components/AppModal'
import { FileContentProvider } from '@/lib/content.file'
import type { HomeContent } from '@/lib/content'
import { auth } from '@/lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'

export default function DashboardPage() {
  const [content, setContent] = useState<HomeContent | null>(null)
  const [current, setCurrent] = useState(0)
  const { user, userCode } = useAuth()
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false)
  const router = useRouter()

  // LIVEモーダル状態
  const [liveModalOpen, setLiveModalOpen] = useState(false)
  const [liveModalText, setLiveModalText] = useState('')

  // コンテンツ読み込み
  useEffect(() => {
    FileContentProvider.getHomeContent().then(setContent)
  }, [])

  // スライダー画像切り替え
  useEffect(() => {
    if (!content?.heroImages?.length) return
    const interval = setInterval(() => {
      setCurrent((prev) => (prev + 1) % content.heroImages.length)
    }, 4000)
    return () => clearInterval(interval)
  }, [content])

  // メニュー項目
  const menuItems: { title: string; link: string; img: string; alt: string }[] = [
    { title: 'Mu_AI', link: '/mu_full', img: '/mu_ai.png', alt: 'Mu_AI' },
    { title: '共鳴会', link: '/kyomeikai', img: '/kyoumai.png', alt: '共鳴会' },
    { title: '配信', link: '/kyomeikai/live', img: '/live.png', alt: '共鳴会LIVE' },
    { title: 'Create', link: '/create', img: '/mu_create.png', alt: 'Create' },
    { title: 'プラン', link: '/pay', img: '/mu_card.png', alt: 'プラン' },
  ]

  const tileVariants = ['tile--mu', 'tile--kyomei', 'tile--live', 'tile--plan', 'tile--create'] as const
  const needsUserParam = new Set<string>(['/mu_ai', '/kyomeikai', '/kyomeikai/live', '/create'])

  const handleClick = async (link: string) => {
    const currentUser = auth.currentUser

    if (!user || !userCode || typeof userCode !== 'string' || userCode.trim() === '') {
      // 念のため再確認
      onAuthStateChanged(auth, (confirmedUser) => {
        if (!confirmedUser) {
          console.warn('[handleClick] 認証されていません → モーダル表示')
          setIsLoginModalOpen(true)
          return
        }
        console.log('[handleClick] onAuthStateChanged により認証確認 → 続行')
        continueNavigation(link, confirmedUser)
      })
      return
    }

    continueNavigation(link, currentUser)
  }

  const continueNavigation = async (link: string, currentUser: typeof auth.currentUser) => {
    if (link === '/mu_full') {
      if (!currentUser) {
        setIsLoginModalOpen(true)
        return
      }

      try {
        const idToken = await currentUser.getIdToken(true)
        const res = await fetch('/api/mu-ai/send-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        })

        if (!res.ok) {
          console.error('[MU-AI] トークン送信失敗:', await res.text())
          return
        }

        const result = await res.json()
        if (result?.getUserInfo?.error) {
          console.warn('[MU-AI] get-user-info エラー:', result.getUserInfo.error)
        }
        if (result?.callMuAi?.error) {
          console.warn('[MU-AI] call-mu-ai エラー:', result.callMuAi.error)
        }

        router.push('/mu_full')
      } catch (err) {
        console.error('[MU-AI] トークン送信失敗:', err)
        setIsLoginModalOpen(true)
      }
      return
    }

    // 📍 Createボタン選択時の処理
    if (link === '/create') {
      if (!currentUser) {
        console.warn('[Create] Firebase未ログイン → モーダル表示')
        setIsLoginModalOpen(true)
        return
      }

      router.push('/create')
      return
    }

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
      needsUserParam.has(link) ? `${link}?user=${encodeURIComponent(userCode ?? '')}` : link
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
      <div style={{ paddingTop: '2.5px' }}>
        {/* スライダー */}
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

        {/* お知らせ */}
        <section className="notice-section">
          <h2 className="notice-title">📢 お知らせ</h2>
          {notices.map((n) => (
            <div key={n.id} className="notice-item">
              {n.text}
            </div>
          ))}
        </section>

        {/* タイルメニュー */}
        <section className="tile-grid">
          {menuItems.map((item, idx) => (
            <div
              key={item.title}
              className={`tile mu-card ${tileVariants[idx]} ${!user ? 'disabled' : ''}`}
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

      {/* ログインモーダル */}
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
