"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import CardRegisterModal from "@/components/CardRegisterModal"; // ✅ 追加

export default function AccountPage() {
  const [userData, setUserData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // ✅ モーダル制御用 state
  const [showCardModal, setShowCardModal] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch("/api/account-status");
        const data = await res.json();
        setUserData(data);
      } catch (err) {
        console.error("Error fetching account data:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  if (loading) return <p>読み込み中...</p>;
  if (!userData) return <p>ユーザーデータが取得できませんでした。</p>;

  const {
    usercode,
    payjpCustomerId,
    cardRegistered,
    planName,
    nextBillingDate,
    subscriptionStatus,
  } = userData;

  return (
    <>
      <Card className="p-4 max-w-xl mx-auto mt-8">
        <CardHeader>
          <h2 className="text-xl font-semibold">アカウント情報</h2>
        </CardHeader>

        <CardContent className="space-y-4">
          <p>🆔 ユーザーコード：<strong>{usercode}</strong></p>
          <p>💳 PAY.JP 顧客ID：<strong>{payjpCustomerId || "未登録"}</strong></p>
          <p>📦 現在のプラン：<strong>{planName || "フリープラン"}</strong></p>
          <p>🗓️ 次回課金日：<strong>{nextBillingDate || "未設定"}</strong></p>
          <p>💠 カード登録：{cardRegistered ? "✅ 登録済み" : "❌ 未登録"}</p>
          <p>📡 契約状態：<strong>{subscriptionStatus || "未契約"}</strong></p>

          {/* ✅ カード未登録なら登録ボタンを表示 */}
          {!cardRegistered && (
            <Button
              variant="outline"
              onClick={() => setShowCardModal(true)} // ✅ モーダルを開く
            >
              💳 カードを登録する
            </Button>
          )}

          {/* ✅ カード登録済みなら変更ボタン */}
          {cardRegistered && (
            <Button
              variant="secondary"
              onClick={() => window.location.href = "/api/payjp/change-card"}
            >
              🔁 カード情報を変更する
            </Button>
          )}
        </CardContent>
      </Card>

      {/* ✅ カード登録モーダル */}
      <CardRegisterModal
        isOpen={showCardModal}
        onClose={() => setShowCardModal(false)}
        userCode={usercode} // ✅ APIから取得したusercodeを渡す
      />
    </>
  );
}
