'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import '../styles/dashboard.css'
import Header from '../components/Header'
import LoginModal from '../components/LoginModal'
import { useAuth } from '@/context/AuthContext'

export default function DashboardPage() {
  const images = ['/mu_24.png', '/mu_14.png']
  const [current, setCurrent] = useState(0)
  const { user, userCode } = useAuth() // ✅ userCode を取得
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false)
  const router = useRouter()

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrent((prev) => (prev + 1) % images.length)
    }, 4000)
    return () => clearInterval(interval)
  }, [])

  const menuItems = [
    { icon: '🤖', title: 'Mu_AI', link: '/mu_ai' },
    { icon: '💳', title: 'クレジット', link: '/credit' },
    { icon: '🌸', title: '共鳴会', link: '/kyomeikai' },
  ]

  const handleClick = (link: string) => {
    if (!user || !userCode) {
      setIsLoginModalOpen(true)
      return
    }

    // ✅ userCode をクエリに付加して遷移
    const linkWithParam = `${link}?user=${encodeURIComponent(userCode)}`
    router.push(linkWithParam)
  }

  return (
    <div
      className="dashboard-wrapper"
      onClick={() => {
        if (!user) setIsLoginModalOpen(true)
      }}
    >
      <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', zIndex: 50 }}>
        <Header onLoginClick={() => setIsLoginModalOpen(true)} />
      </div>

      <div style={{ paddingTop: '65px' }}>
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
          <div className="notice-item">
            共鳴会の開催 — 小さな気づきや成長を仲間と分かち合う場
          </div>
          <div className="notice-item">
            思いを整理する習慣 — Muからの問いかけで日々の心を整える
          </div>
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
              <div className="tile-icon">{item.icon}</div>
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
