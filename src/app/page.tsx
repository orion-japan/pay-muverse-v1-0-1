'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import '../styles/dashboard.css'
import LoginModal from '../components/LoginModal'
import { useAuth } from '@/context/AuthContext'

import { FileContentProvider } from '@/lib/content.file'
import type { HomeContent } from '@/lib/content'

export default function DashboardPage() {
  const [content, setContent] = useState<HomeContent | null>(null)
  const [current, setCurrent] = useState(0)
  const { user, userCode } = useAuth()
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false)
  const router = useRouter()

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

  // ✅ 並びを「Mu_AI / 共鳴会 / プラン」に変更
  // ✅ 画像アイコンを使用（/public 直下）
  const menuItems: { title: string; link: string; img: string; alt: string }[] = [
    { title: 'Mu_AI',  link: '/mu_full',    img: '/mu_ai.png',   alt: 'Mu_AI' },
    { title: '共鳴会',  link: '/kyomeikai',  img: '/kyoumai.png', alt: '共鳴会' }, // ← ファイル名指定どおり
    { title: 'プラン',  link: '/pay',        img: '/mu_card.png', alt: 'プラン' },
  ]

  // ✅ userクエリが必要なページだけ
  const needsUserParam = new Set<string>(['/mu_ai'])

  const handleClick = (link: string) => {
    if (!user || !userCode) {
      setIsLoginModalOpen(true)
      return
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
          {menuItems.map((item) => (
            <div
              key={item.title}
              className={`tile ${!user ? 'disabled' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                handleClick(item.link)
              }}
            >
              {/* 画像ボタン（Tailwindなし） */}
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
          ))}
        </section>
      </div>

      <LoginModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onLoginSuccess={() => setIsLoginModalOpen(false)}
      />
    </div>
  )
}
