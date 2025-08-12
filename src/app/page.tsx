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

if (link === '/mu_full') {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    console.warn('[MU-AI] Firebase未ログイン → モーダル表示');
    setIsLoginModalOpen(true);
    return;
  }

  try {
    const idToken = await currentUser.getIdToken(true);
    console.log('[MU-AI] idToken 取得成功:', idToken.substring(0, 20) + '...');

// ① MU 側に転送するための API を呼び出し
const res = await fetch('/api/mu-ai/send-token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ idToken }),
});

if (!res.ok) {
  console.error('[MU-AI] トークン送信失敗:', await res.text());
  return;
}

try {
  const result = await res.json();
  console.log('[MU-AI] send-token API 成功:', result);

  // get-user-info の結果
  if (result?.getUserInfo?.error) {
    console.warn('[MU-AI] get-user-info エラー:', result.getUserInfo.error);
  } else {
    console.log('[MU-AI] get-user-info 応答:', result.getUserInfo);
  }

  // call-mu-ai の結果
  if (result?.callMuAi?.error) {
    console.warn('[MU-AI] call-mu-ai エラー:', result.callMuAi.error);
  } else {
    console.log('[MU-AI] call-mu-ai 応答:', result.callMuAi);
  }
} catch (err) {
  console.error('[MU-AI] send-token API 応答JSON解析失敗:', err);
  return;
}


    // ② 成功したら MU 側ページに遷移
    router.push('/mu_full');
    return;
  } catch (err) {
    console.error('[MU-AI] idToken取得または送信失敗:', err);
    setIsLoginModalOpen(true);
    return;
  }
}

      
    


    // LIVEページ事前チェック
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
