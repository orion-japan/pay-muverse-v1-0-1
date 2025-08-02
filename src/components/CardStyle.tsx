'use client'

import { useEffect } from 'react'
import '@/app/globals.css'

// ✅ Props型を定義（onReady を追加）
type Props = {
  onNameChange?: (name: string) => void;
  onCardReady?: (ready: boolean) => void;   // ← iframe readyを親に伝える
};

export default function CardStyle({ onNameChange, onCardReady }: Props) {
  useEffect(() => {
    console.log('[CardStyle] マウント開始');

    // ✅ PAY.JPスクリプト多重読み込み防止
    if (document.querySelector('script[src="https://js.pay.jp/v2/pay.js"]')) {
      console.log('[CardStyle] すでに pay.js 読み込み済み');
      return;
    }

    const s = document.createElement('script');
    s.src = 'https://js.pay.jp/v2/pay.js';
    s.onload = () => {
      console.log('[CardStyle] PAY.JP script loaded ✅');

      const payjp = (window as any).Payjp(process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY!);
      const elements = payjp.elements();

      // ✅ iframe 内のスタイル設定
      const style = {
        base: {
          fontSize: '16px',
          color: '#222',
          letterSpacing: '0.03em',
          padding: '12px',
          '::placeholder': { color: '#9ca3af' }
        }
      };

      // ✅ 各フォーム mount
      const cardNumber = elements.create('cardNumber', { style });
      const cardExpiry = elements.create('cardExpiry', { style });
      const cardCvc    = elements.create('cardCvc', { style });

      // ---- iframe Ready イベント ----
      cardNumber.on('ready', () => {
        console.log('✅ cardNumber iframe 完全 ready');
        onCardReady?.(true);  // 親に「カード入力欄 ready」を通知
      });

      cardExpiry.on('ready', () => {
        console.log('✅ cardExpiry iframe 完全 ready');
      });

      cardCvc.on('ready', () => {
        console.log('✅ cardCvc iframe 完全 ready');
      });

      cardNumber.mount('#card-number');
      console.log('[CardStyle] cardNumber mount 完了');

      cardExpiry.mount('#card-expiry');
      console.log('[CardStyle] cardExpiry mount 完了');

      cardCvc.mount('#card-cvc');
      console.log('[CardStyle] cardCvc mount 完了');
    };

    document.body.appendChild(s);
  }, [onCardReady]);

  return (
    <div className="payjp-wrap">
      <div className="payjp-card-box">
        <h2 className="payjp-title">💳 支払い情報</h2>

        {/* ✅ ロゴ行 */}
        <div className="payjp-brand-row">
          {['visa','mastercard','jcb','amex','diners'].map(b => (
            <img 
              key={b} 
              src={`/${b}.png`}  // publicフォルダの画像を表示
              alt={b} 
              className="payjp-brand-icon"
            />
          ))}
        </div>

        {/* ✅ 入力欄 */}
        <div className="payjp-form">
          <label className="payjp-label">カード番号</label>
          <div id="card-number" className="payjp-input" />

          <div className="payjp-two-col">
  <div className="expiry-box">
    <label className="payjp-label">有効期限</label>
    <div id="card-expiry" className="payjp-input" />
  </div>
  <div className="cvc-box">
    <label className="payjp-label">CVC番号</label>
    <div id="card-cvc" className="payjp-input" />
  </div>
</div>


          {/* ✅ 名義入力 → 親に渡す */}
          <label className="payjp-label">カード名義（半角英字）</label>
          <input
            type="text"
            placeholder="TARO YAMADA"
            className="payjp-input"
            onChange={(e) => onNameChange?.(e.target.value)}
          />
        </div>
      </div>
    </div>
  )
}
