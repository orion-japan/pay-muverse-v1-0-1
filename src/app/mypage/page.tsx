// MyPage.tsx（修正版）
"use client";

import React, { useEffect, useState } from "react";
import "./mypage.css";
import { useRouter } from "next/navigation";
import { getAuth } from "firebase/auth";

export default function MyPage() {
  const [profile, setProfile] = useState<any>(null);
  const router = useRouter();

  useEffect(() => {
    const auth = getAuth();
    const user = auth.currentUser;

    if (!user) {
      router.push("/login");
      return;
    }

    user.getIdToken(true)
      .then((token) => {
        return fetch("/api/get-current-user", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        });
      })
      .then((res) => {
        if (!res.ok) throw new Error("ユーザー情報取得エラー");
        return res.json();
      })
      .then((user) => {
        if (user?.user_code) {
          fetch(`/api/get-profile?code=${user.user_code}`)
            .then((res) => res.json())
            .then((data) => setProfile(data))
            .catch(() => setProfile(null));
        } else {
          setProfile(null);
        }
      })
      .catch(() => setProfile(null));
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
    // 配列を日本語カンマで結合して表示（1つでも自然に見える）
    return <div className="profile-value scroll-x">{value.join("、")}</div>;
  }

  return <div className="profile-value scroll-x">{value}</div>;
};


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
            <div className="mypage-input">
              {renderText(Array.isArray(profile.interests) ? profile.interests.join("、") : profile.interests)}
            </div>
          </div>

          <div className="mypage-section">
            <div className="mypage-label">スキル</div>
            <div className="mypage-input">
              {renderText(Array.isArray(profile.skills) ? profile.skills.join("、") : profile.skills)}
            </div>
          </div>

          <div className="mypage-section">
            <div className="mypage-label">活動地域</div>
            <div className="mypage-input">{renderText(profile.activity_area)}</div>
          </div>

          <div className="mypage-section">
            <div className="mypage-label">対応言語</div>
            <div className="mypage-input">
              {renderText(Array.isArray(profile.languages) ? profile.languages.join("、") : profile.languages)}
            </div>
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