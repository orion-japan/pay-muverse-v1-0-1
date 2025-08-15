// MyPage.tsx（onAuthStateChanged対応・構造保持）
"use client";

import React, { useEffect, useState } from "react";
import "./mypage.css";
import { useRouter } from "next/navigation";
import { getAuth, onAuthStateChanged, User } from "firebase/auth";

export default function MyPage() {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true); // ローディング状態
  const router = useRouter();

  useEffect(() => {
    const auth = getAuth();

    // Firebase認証状態を監視
    const unsubscribe = onAuthStateChanged(auth, async (user: User | null) => {
      if (!user) {
        console.warn("[MyPage] ログインしていないため /login へ移動");
        router.push("/login");
        return;
      }

      try {
        const token = await user.getIdToken(true);
        console.log("[MyPage] ✅ Firebaseトークン取得成功");

        // ユーザー情報取得
        const resUser = await fetch("/api/get-current-user", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        });

        if (!resUser.ok) throw new Error("ユーザー情報取得エラー");
        const userData = await resUser.json();

        if (userData?.user_code) {
          console.log("[MyPage] ✅ user_code取得:", userData.user_code);

          // プロフィール取得
          const resProfile = await fetch(`/api/get-profile?code=${userData.user_code}`);
          if (!resProfile.ok) throw new Error("プロフィール取得エラー");

          const profileData = await resProfile.json();
          console.log("[MyPage] ✅ プロフィール取得成功:", profileData);
          setProfile(profileData);
        } else {
          console.warn("[MyPage] user_codeなし → プロフィール未登録扱い");
          setProfile(null);
        }
      } catch (err) {
        console.error("[MyPage] ❌ データ取得中にエラー:", err);
        setProfile(null);
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, [router]);

  const renderLink = (value: string | null) => {
    if (!value) return <div className="profile-value">-</div>;
    if (/^https?:\/\//i.test(value)) {
      return (
        <div className="profile-value scroll-x">
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 underline"
          >
            {value}
          </a>
        </div>
      );
    }
    return <div className="profile-value scroll-x">{value}</div>;
  };

  const renderText = (value: string | string[] | null) => {
    if (!value || (Array.isArray(value) && value.length === 0))
      return <div className="profile-value">-</div>;
    if (Array.isArray(value)) {
      return <div className="profile-value scroll-x">{value.join("、")}</div>;
    }
    return <div className="profile-value scroll-x">{value}</div>;
  };

  if (loading) {
    return (
      <div className="mypage-body">
        <div className="mypage-container scrollable">
          <p>読み込み中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mypage-body">
      <div className="mypage-container scrollable">
        <h1>マイページ</h1>

        {!profile ? (
          <>
            <p>プロフィールが登録されていません</p>
            <div className="mypage-button-group">
              <button
                className="mypage-button"
                onClick={() => router.push("/mypage/create")}
              >
                登録
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mypage-section">
              <div className="mypage-label">ユーザーコード</div>
              <div className="mypage-input">{renderText(profile.user_code)}</div>
            </div>

            <div className="mypage-section">
              <div className="mypage-label">誕生日</div>
              <div className="mypage-input">{renderText(profile.birthday)}</div>
            </div>

            <div className="mypage-section">
              <div className="mypage-label">所在地</div>
              <div className="mypage-input">
                {renderText(`${profile.prefecture || ""} ${profile.city || ""}`)}
              </div>
            </div>

            <div className="mypage-section">
              <div className="mypage-label">X (Twitter)</div>
              <div className="mypage-input">{renderLink(profile.x_handle)}</div>
            </div>

            <div className="mypage-section">
              <div className="mypage-label">Instagram</div>
              <div className="mypage-input">{renderLink(profile.instagram)}</div>
            </div>

            <div className="mypage-section">
              <div className="mypage-label">Facebook</div>
              <div className="mypage-input">{renderLink(profile.facebook)}</div>
            </div>

            <div className="mypage-section">
              <div className="mypage-label">LinkedIn</div>
              <div className="mypage-input">{renderLink(profile.linkedin)}</div>
            </div>

            <div className="mypage-section">
              <div className="mypage-label">YouTube</div>
              <div className="mypage-input">{renderLink(profile.youtube)}</div>
            </div>

            <div className="mypage-section">
              <div className="mypage-label">Webサイト</div>
              <div className="mypage-input">{renderLink(profile.website_url)}</div>
            </div>

            <div className="mypage-section">
              <div className="mypage-label">興味</div>
              <div className="mypage-input">{renderText(profile.interests)}</div>
            </div>

            <div className="mypage-section">
              <div className="mypage-label">スキル</div>
              <div className="mypage-input">{renderText(profile.skills)}</div>
            </div>

            <div className="mypage-section">
              <div className="mypage-label">活動地域</div>
              <div className="mypage-input">{renderText(profile.activity_area)}</div>
            </div>

            <div className="mypage-section">
              <div className="mypage-label">対応言語</div>
              <div className="mypage-input">{renderText(profile.languages)}</div>
            </div>

            <div className="mypage-button-group">
              <button
                className="mypage-button"
                onClick={() => router.push("/mypage/create")}
              >
                修正
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
