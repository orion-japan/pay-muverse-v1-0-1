'use client';

import { useRouter } from 'next/navigation';
import './lessons.css';

export default function LessonsMenu() {
  const router = useRouter();

  return (
    <div className="lessons__wrap">
      {/* 戻るボタン */}
      <button className="backBtn" onClick={() => router.back()} aria-label="戻る">
        ← 戻る
      </button>
      <br />
      <h1 className="lessons__title">階層レクチャー</h1>
      <p className="lessons__intro">
        フェーズ・位相ベクトル・認識深度レベルなど、Sofia構造の学習ページです。
      </p>

      <div className="lessons__grid">
        {/* クリック無効化：Linkをやめてdivにする */}
        <div className="lessons__card lessons__card--disabled">
          <div className="lessons__card-emoji">🌱</div>
          <div className="lessons__card-title">フェーズ・ドリフト軸</div>
          <div className="lessons__card-desc">意思変容プロセスの流れ</div>
        </div>

        <div className="lessons__card lessons__card--disabled">
          <div className="lessons__card-emoji">☯️</div>
          <div className="lessons__card-title">位相ベクトル</div>
          <div className="lessons__card-desc">内外エネルギーの傾向</div>
        </div>

        <div className="lessons__card lessons__card--disabled">
          <div className="lessons__card-emoji">🔎</div>
          <div className="lessons__card-title">認識深度レベル</div>
          <div className="lessons__card-desc">意図の階層マッピング</div>
        </div>
      </div>
    </div>
  );
}
