'use client'

// ✅ Props 型を export（Modal からも型補完される）
export type CardFormProps = {
  userCode: string
  onRegister: () => void
}

import { useEffect, useState } from 'react';

export default function CardForm({ userCode }: { userCode: string }) {
  const [userData, setUserData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [payjp, setPayjp] = useState<any>(null);
  const [card, setCard] = useState<any>(null);
  const [cardReady, setCardReady] = useState(false);

  useEffect(() => {
    console.log("🟢 CardForm.tsx 正常ロード");
  }, []);

  // ✅ Supabaseからユーザーデータ取得
  useEffect(() => {
    const fetchStatus = async () => {
      console.log('🔍 userCode 取得:', userCode);
      const res = await fetch(`/api/account-status?user=${userCode}`);
      const json = await res.json();
      console.log('📦 ユーザーデータ取得:', json);
      setUserData(json);
      setLoading(false);
    };
    if (userCode) fetchStatus();
  }, [userCode]);

  // ✅ PAY.JP 初期化
  useEffect(() => {
    const initPayjp = async () => {
      if (!userData || userData?.card_registered) {
        console.log("⛔ userDataがないか、既にカード登録済み");
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://js.pay.jp/v2/pay.js';
      script.async = true;
      script.onload = () => {
        console.log("📦 PAY.JP script 読み込み完了");

        const pubKey = process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY;
        if (!pubKey) {
          console.error('❌ PAY.JP 公開鍵が未定義');
          return;
        }

        const payjpInstance = (window as any).Payjp(pubKey);
        const elements = payjpInstance.elements();
        const cardElement = elements.create('card');
        const mountTarget = document.getElementById('card-element');

        if (!mountTarget) {
          console.error('❌ #card-element がDOMに存在しません');
          return;
        }

        cardElement.on('change', (e: any) => {
          setCardReady(e.complete);
        });

        cardElement.mount('#card-element');
        console.log("✅ cardElement マウント完了");

        setPayjp(payjpInstance);
        setCard(cardElement);
      };

      document.body.appendChild(script);
    };

    initPayjp();
  }, [userData]);

  // ✅ カード登録処理
  const handleCardRegistration = async () => {
    console.log("🚀 カード登録処理スタート");

    if (!payjp || !card) {
      console.error("❌ payjp or card 未初期化");
      alert("PAY.JPの初期化が完了していません");
      return;
    }

    // ✅ 名前入力欄の値を取得
    const nameInput = (document.getElementById('card-holder-name') as HTMLInputElement)?.value;
    if (!nameInput) {
      alert("カード名義を入力してください");
      return;
    }
    console.log("📝 カード名義:", nameInput);

    // ✅ 名前を含めてトークン作成
    const result = await payjp.createToken(card, { name: nameInput });
    console.log("🎫 トークン生成結果:", result);

    if (result.error) {
      console.error('❌ トークン作成エラー:', result.error);
      alert(result.error.message);
      return;
    }

    const token = result.id;
    console.log("✅ トークン取得成功:", token);

    // ✅ register-card APIへ送信
    const cardRes = await fetch('/api/pay/account/register-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_code: userCode, token }),
    });

    const cardJson = await cardRes.json();
    console.log("📨 register-card API 応答:", cardJson);

    if (cardRes.ok) {
      alert('カード登録が完了しました！');
      const res = await fetch(`/api/account-status?user=${userCode}`);
      const json = await res.json();
      setUserData(json);
    } else {
      alert('カード登録に失敗しました');
    }
  };

  if (loading) return <p className="loading-text">読み込み中...</p>;

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

        {/* ✅ 名前入力欄を追加（id付き） */}
        <div className="form-group">
          <label>カード名義</label>
          <input
            type="text"
            id="card-holder-name"
            placeholder="TARO YAMADA"
            className="name-input"
          />
        </div>

        <button
          type="button"
          onClick={handleCardRegistration}
          disabled={!cardReady || loading}
          className="submit-btn"
        >
          {loading ? '登録中...' : 'クレジットカードを登録'}
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
        .name-input {
          width: 100%;
          padding: 10px;
          font-size: 14px;
          border: 1px solid #ccc;
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
        .loading-text {
          text-align: center;
          margin-top: 20px;
          font-size: 14px;
          color: #555;
        }
      `}</style>
    </>
  );
}