'use client'
import { useState } from 'react'
import './globals.css'
import '../styles/layout.css'
import Footer from '../components/Footer'
import LoginModal from '../components/LoginModal'
import { AuthProvider } from '@/context/AuthContext'

export default function RootLayout({ children }) {
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false)
  const openLoginModal = () => setIsLoginModalOpen(true)
  const closeLoginModal = () => setIsLoginModalOpen(false)

  return (
    <html lang="ja">
      <body>
        <AuthProvider>
          {/* ✅ Header は削除 */}

          <div className="frame-container">
            <main className="main-content">
              {children}
            </main>
          </div>

          <Footer />

          <LoginModal
            isOpen={isLoginModalOpen}
            onClose={closeLoginModal}
          />
        </AuthProvider>
      </body>
    </html>
  )
}
