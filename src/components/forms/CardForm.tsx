'use client';

import { useEffect } from 'react';
import './card-style.css';   // 🎨 ← ここで card-style.css を読み込む
type CardFormProps = {
  userCode: string;   // ✅ ここを追加
};
export default function CardForm() {
  /* ------------ PAY.JP 初期化 ------------ */
  useEffect(() => {
    const s = document.createElement('script');
    s.src = 'https://js.pay.jp/v2/pay.js';
    s.onload = () => {
      const payjp = (window as any).Payjp(process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY!);
      const elements = payjp.elements();

      const style = {
        base: {
          fontSize: '16px',
          color: '#222',
          letterSpacing: '0.05em',
          padding: '12px',
          '::placeholder': { color: '#9ca3af' },
        },
      };

      elements.create('cardNumber', { style }).mount('#card-number');
      elements.create('cardExpiry', { style }).mount('#card-expiry');
      elements.create('cardCvc', { style }).mount('#card-cvc');
    };
    document.body.appendChild(s);
  }, []);

  return (
    <div className="page-wrap">
      <div className="card-box">
        {/* ── タイトル & ロゴ ── */}
        <div className="title-block">
          <h2 className="title">支払い情報</h2>
          <div className="brand-row">
            {['visa', 'mastercard', 'jcb', 'amex', 'discover', 'diners'].map((b) => (
              <img key={b} src={`/${b}.png`} alt={b} className="brand-icon" />
            ))}
          </div>
        </div>

        {/* ── 入力欄 ── */}
        <div className="form-block">
          <label className="field-label">カード番号</label>
          <div id="card-number" className="input-box" />

          <div className="two-col">
            <div>
              <label className="field-label">有効期限</label>
              <div id="card-expiry" className="input-box" />
            </div>
            <div>
              <label className="field-label">CVC番号</label>
              <div id="card-cvc" className="input-box" />
            </div>
          </div>

          <label className="field-label">名前</label>
          <input type="text" placeholder="TARO YAMADA" className="input-box" />
        </div>

        {/* ── ボタン ── */}
        <button className="submit-btn">カードで支払う</button>
      </div>
    </div>
  );
}
