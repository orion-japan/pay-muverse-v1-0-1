'use client';

import { useEffect, useRef } from 'react';
import '@/app/globals.css';

export default function CardStyle() {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;   // ✅ mountの二重実行を防止
    initialized.current = true;

    console.log('✅ PAY.JP スクリプト読み込み開始');

    const script = document.createElement('script');
    script.src = 'https://js.pay.jp/v2/pay.js';
    script.onload = () => {
      console.log('✅ PAY.JP スクリプト読込完了');

      const payjp = (window as any).Payjp(process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY!);
      const elements = payjp.elements();

      const style = {
        base: {
          fontSize: '16px',
          color: '#222',
          letterSpacing: '0.03em',
          padding: '12px',
          '::placeholder': { color: '#9ca3af' },
        },
      };

      // ✅ DOMが存在するかチェックしてから mount
      const numberEl = document.getElementById('card-number');
      const expiryEl = document.getElementById('card-expiry');
      const cvcEl = document.getElementById('card-cvc');

      if (numberEl && expiryEl && cvcEl) {
        elements.create('cardNumber', { style }).mount('#card-number');
        console.log('✅ cardNumber mount 完了');

        elements.create('cardExpiry', { style }).mount('#card-expiry');
        console.log('✅ cardExpiry mount 完了');

        elements.create('cardCvc', { style }).mount('#card-cvc');
        console.log('✅ cardCvc mount 完了');
      } else {
        console.error('❌ mount対象のDOMが存在しません');
      }
    };

    document.body.appendChild(script);
  }, []);

  return (
    <div className="payjp-wrap">
      <div className="payjp-card-box">
        <h2 className="payjp-title">支払い情報</h2>

        <div className="payjp-brand-row">
          {['visa', 'mastercard', 'jcb', 'amex', 'diners'].map((b) => (
            <img key={b} src={`/${b}.png`} alt={b} className="payjp-brand-icon" />
          ))}
        </div>

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
          <input type="text" placeholder="TARO YAMADA" className="payjp-input" />
        </div>

        {/* ✅ 「カードで支払う」ボタンは削除済み */}
      </div>
    </div>
  );
}


