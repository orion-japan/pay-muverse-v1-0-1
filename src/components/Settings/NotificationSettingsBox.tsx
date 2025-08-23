'use client';

import { useEffect, useState } from 'react';
import { getAuth } from 'firebase/auth';

type Plan = 'free' | 'regular' | 'premium' | 'master' | 'admin';

type Props = {
  planStatus: Plan;
};

export default function NotificationSettingsBox({ planStatus }: Props) {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    // 通知設定の取得処理（必要であれば実装）
    setLoading(false);
  }, []);

  if (loading) return <div>読み込み中...</div>;

  return (
    <section style={{ border: '1px solid #eee', borderRadius: 12, padding: 16 }}>
      <h3 style={{ marginBottom: 8 }}>通知・公開設定</h3>

      <label>
        <input type="checkbox" defaultChecked /> プッシュ通知を有効にする
      </label>
      <br />

      <label>
        <input type="checkbox" defaultChecked /> 通知時にバイブレーション
      </label>
      <br />

      <div style={{ marginTop: 8 }}>
        <label>SelfTalk 通知範囲</label><br />
        <select defaultValue="all">
          <option value="all">全員</option>
          <option value="mates">シップメイトのみ</option>
        </select>
      </div>

      <div style={{ marginTop: 8 }}>
        <label>Create（I Board）通知範囲</label><br />
        <select defaultValue="all">
          <option value="all">全員</option>
          <option value="mates">シップメイトのみ</option>
        </select>
      </div>

      <div style={{ marginTop: 8 }}>
        <label>
          <input type="checkbox" defaultChecked /> F Talk の通知を受け取る
        </label>
        <br />
        <label>
          <input type="checkbox" defaultChecked /> R Talk の通知を受け取る
        </label>
        <br />
        <label>
          <input type="checkbox" defaultChecked /> 共鳴の通知
        </label>
        <br />
        <label>
          <input type="checkbox" defaultChecked /> ライティングの通知
        </label>
        <br />
        <label>
          <input type="checkbox" defaultChecked /> AIからの通知
        </label>
        <br />
        <label>
          <input type="checkbox" defaultChecked /> クレジット（サブスク切れ）の通知
        </label>
      </div>

      <button style={{ marginTop: 12 }}>保存</button>

      {errorMsg && <div style={{ color: 'red', marginTop: 8 }}>{errorMsg}</div>}
    </section>
  );
}
