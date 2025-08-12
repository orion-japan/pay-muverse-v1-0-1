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

export default function DashboardPage() {
  const [content, setContent] = useState<HomeContent | null>(null)
  const [current, setCurrent] = useState(0)
  const { user, userCode } = useAuth()
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false)
  const [muIframeSrc, setMuIframeSrc] = useState<string | null>(null) // ← 追加
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
    { title: 'プラン', link: '/pay', img: '/mu_card.png', alt: 'プラン' },
  ]
  const tileVariants = ['tile--mu', 'tile--kyomei', 'tile--live', 'tile--plan'] as const
  const needsUserParam = new Set<string>(['/mu_ai', '/kyomeikai', '/kyomeikai/live'])

  const handleClick = async (link: string) => {
    if (!user || !userCode) {
      setIsLoginModalOpen(true)
      return
    }

    // Mu_AI は Firebaseトークンで認証後、iframe表示
    if (link === '/mu_full') {
      try {
        const currentUser = auth.currentUser
        if (!currentUser) {
          console.warn('[MU-AI] Firebase未ログイン → モーダル表示')
          setIsLoginModalOpen(true)
          return
        }

        // Firebase IDトークン取得
        const idToken = await currentUser.getIdToken(true)
        console.log('[MU-AI] Firebase IDトークン取得:', idToken.substring(0, 10) + '...')

        // 自プロジェクトAPI経由でMU側へ送信（call-mu-ai.ts）
        const res = await fetch('/api/call-mu-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: idToken }),
        })

        if (!res.ok) {
          console.error('[MU-AI] 認証API失敗', await res.text())
          return
        }

        const data = await res.json()
        console.log('[MU-AI] 認証OK, MU応答:', data)

        // iframeでMU側表示（user_codeをパラメータで渡す）
        const muBase = process.env.NEXT_PUBLIC_MU_AI_BASE_URL || 'https://m.muverse.jp'
        setMuIframeSrc(`${muBase}?user=${encodeURIComponent(data.user_code || userCode || '')}`)
      } catch (err) {
        console.error('[MU-AI] MU側認証処理エラー:', err)
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

    // 通常ページ遷移
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

        {/* MU iframe表示エリア */}
        {muIframeSrc && (
          <div style={{ marginTop: '20px' }}>
            <iframe
              src={muIframeSrc}
              style={{ width: '100%', height: '80vh', border: 'none' }}
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
          </div>
        )}
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
