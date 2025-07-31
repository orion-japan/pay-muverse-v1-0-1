'use client';

import { useEffect, useState } from 'react';

type Props = {
  userCode: string;
  onRegister?: () => void;   // ✅ これを追加（必須ではない）
};


export default function CardForm({ userCode }: Props) {
  const [payjp, setPayjp] = useState<any>(null);
  const [card, setCard] = useState<any>(null);
  const [cardReady, setCardReady] = useState(false);

  // ✅ PAY.JP Elements 初期化
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://js.pay.jp/v2/pay.js';
    script.async = true;
    script.onload = () => {
      console.log("📦 PAY.JP script loaded");

      const pubKey = process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY;
      if (!pubKey) {
        console.error('❌ PAY.JP 公開鍵が未定義です');
        return;
      }

      const payjpInstance = (window as any).Payjp(pubKey);
      const elements = payjpInstance.elements();

      // ✅ card 要素を作成（1フィールドでカード番号/期限/CVCすべて）
      const cardElement = elements.create('card');
      cardElement.on('change', (e: any) => {
        setCardReady(e.complete);
      });

      cardElement.mount('#card-element');

      setPayjp(payjpInstance);
      setCard(cardElement);
    };

    document.body.appendChild(script);
  }, []);

  // ✅ カード登録処理
  const handleCardRegistration = async () => {
    console.log("🚀 カード登録処理開始");

    if (!payjp || !card) {
      alert("PAY.JP が初期化されていません");
      return;
    }

    // ✅ 1. トークン作成
    const result = await payjp.createToken(card);
    if (result.error) {
      alert(result.error.message);
      return;
    }

    const token = result.id;
    console.log("✅ トークン取得:", token);

    // ✅ 2. API呼び出し（顧客作成 & Supabase更新）
    const res = await fetch('/api/pay/register-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode, token }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("❌ APIエラー:", data);
      alert('カード登録に失敗しました');
      return;
    }

    alert('✅ カード登録が完了しました！');
  };

  return (
    <>
      <form className="card-form">
        <h2>💳 クレジットカード登録</h2>
        <p className="description">以下のカードをご利用いただけます</p>

        <div className="card-logos">
          <img src="/visa.png" alt="VISA" />
          <img src="/mastercard.png" alt="Mastercard" />
          <img src="/jcb.png" alt="JCB" />
          <img src="/amex.png" alt="Amex" />
        </div>

        <div className="form-group">
          <label>カード情報</label>
          <div id="card-element" className="card-element-box" />
        </div>

        {/* ✅ 「カードで支払う」ボタンは一切残さない */}
        <button
          type="button"
          onClick={handleCardRegistration}
          disabled={!cardReady}
          className="submit-btn"
        >
          クレジットカードを登録
        </button>

        <p className="note">安全なSSL通信で送信されます</p>
      </form>

      <style jsx>{`
        .card-form {
          max-width: 420px;
          margin: 40px auto;
          padding: 20px;
          background: #fff;
          border: 1px solid #ddd;
          border-radius: 12px;
          box-shadow: 0 4px 10px rgba(0, 0, 0, 0.08);
          font-family: Arial, sans-serif;
        }
        h2 {
          font-size: 20px;
          text-align: center;
          margin-bottom: 8px;
          color: #333;
        }
        .description {
          font-size: 13px;
          text-align: center;
          color: #666;
          margin-bottom: 12px;
        }
        .card-logos {
          display: flex;
          justify-content: center;
          gap: 8px;
          margin-bottom: 16px;
        }
        .card-logos img {
          height: 26px;
        }
        .form-group {
          margin-bottom: 16px;
        }
        label {
          font-size: 14px;
          font-weight: bold;
          display: block;
          margin-bottom: 6px;
        }
        .card-element-box {
          border: 1px solid #ccc;
          padding: 12px;
          border-radius: 6px;
          background: #fafafa;
        }
        .submit-btn {
          width: 100%;
          padding: 12px;
          font-size: 16px;
          font-weight: bold;
          color: white;
          background-color: #4CAF50;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          margin-top: 12px;
        }
        .submit-btn:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .note {
          font-size: 11px;
          color: #888;
          text-align: center;
          margin-top: 8px;
        }
      `}</style>
    </>
  );
}
