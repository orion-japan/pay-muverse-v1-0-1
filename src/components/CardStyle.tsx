'use client'

import { useEffect } from 'react'
import '@/app/globals.css';   // ✅ appフォルダ直下のglobals.cssを読み込む

export default function CardStyle() {
  /* ------------ PAY.JP 初期化 ------------ */
  useEffect(() => {
    const s = document.createElement('script')
    s.src = 'https://js.pay.jp/v2/pay.js'
    s.onload = () => {
      const payjp = (window as any).Payjp(process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY!)
      const elements = payjp.elements()

      // ✅ iframe内部のスタイル（基本設定）
      const style = {
        base: {
          fontSize: '16px',
          color: '#222',
          letterSpacing: '0.03em',
          padding: '12px',
          '::placeholder': { color: '#9ca3af' }
        }
      }

      // ✅ 各フォームをマウント
      elements.create('cardNumber', { style }).mount('#card-number')
      elements.create('cardExpiry', { style }).mount('#card-expiry')
      elements.create('cardCvc', { style }).mount('#card-cvc')
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

        {/* 🚫 ❌ ここにあった “カードで支払う” ボタンは削除 */}
      </div>
    </div>
  )
}
