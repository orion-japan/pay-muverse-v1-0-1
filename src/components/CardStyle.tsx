'use client'

import { useEffect } from 'react'
import '@/app/globals.css'   // ✅ appフォルダ直下のglobals.cssを読み込む

export default function CardStyle() {
  /* ------------ PAY.JP 初期化 ------------ */
  useEffect(() => {
    const s = document.createElement('script')
    s.src = 'https://js.pay.jp/v2/pay.js'
    s.onload = () => {
      // ✅ DOMが確実に描画された後に mount 実行
      setTimeout(() => {
        const payjp = (window as any).Payjp(process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY!)
        const elements = payjp.elements()

        // ✅ iframe 内のスタイル
        const style = {
          base: {
            fontSize: '16px',
            color: '#222',
            letterSpacing: '0.03em',
            padding: '12px',
            '::placeholder': { color: '#9ca3af' }
          }
        }

        // ✅ mount の前に DOM が存在するか確認してから実行
        const cardNumberEl = document.getElementById('card-number')
        if (cardNumberEl) {
          elements.create('cardNumber', { style }).mount('#card-number')
        } else {
          console.warn('⚠️ #card-number が見つかりません')
        }

        const cardExpiryEl = document.getElementById('card-expiry')
        if (cardExpiryEl) {
          elements.create('cardExpiry', { style }).mount('#card-expiry')
        } else {
          console.warn('⚠️ #card-expiry が見つかりません')
        }

        const cardCvcEl = document.getElementById('card-cvc')
        if (cardCvcEl) {
          elements.create('cardCvc', { style }).mount('#card-cvc')
        } else {
          console.warn('⚠️ #card-cvc が見つかりません')
        }
      }, 500) // ← 0.5秒遅延で DOM が確実にある状態にする
    }
    document.body.appendChild(s)
  }, [])

  return (
    <div className="payjp-wrap">
      <div className="payjp-card-box">
        {/* ── タイトル & ロゴ ── */}
        <h2 className="payjp-title">支払い情報</h2>

        <div className="payjp-brand-row">
          {['visa','mastercard','jcb','amex','diners'].map(b => (
            <img key={b} src={`/${b}.png`} alt={b} className="payjp-brand-icon" />
          ))}
        </div>

        {/* ── 入力欄 ── */}
        <div className="payjp-form">
          <label className="payjp-label">カード番号</label>
          <div id="card-number" className="payjp-input" />

          <div className="payjp-two-col">
            <div>
              <label className="payjp-label">有効期限</label>
              <div id="card-expiry" className="payjp-input" />
            </div>
            <div>
              <label className="payjp-label">CVC番号</label>
              <div id="card-cvc" className="payjp-input" />
            </div>
          </div>

          <label className="payjp-label">名前</label>
          <input
            type="text"
            placeholder="TARO YAMADA"
            className="payjp-input"
          />
        </div>

        {/* ── ボタン（PAY.JPのテスト時はUIだけ） ── */}
        <button className="payjp-submit-btn">カードで支払う</button>
      </div>
    </div>
  )
}
