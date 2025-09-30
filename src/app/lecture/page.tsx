'use client';

import Link from 'next/link';
import './lecture.css';
import { useRouter } from 'next/navigation'; 

export default function LectureMenu() {
  const router = useRouter(); 
  return (
<div className="lecture__wrap">
<div className="lessons__wrap">
      {/* 戻るボタン */}
      <button
        className="backBtn"
        onClick={() => router.back()}
        aria-label="戻る"
      >
        ← 戻る
      </button></div>

      <h1 className="lecture__title">Lecture メニュー</h1>
      <p className="lecture__intro">学びとQコード解析のためのメニューです。</p>

      <div className="lecture__grid">
        <Link className="lecture__card" href="/lessons">
          <div className="lecture__card-emoji">📘</div>
          <div className="lecture__card-title">レッスン</div>
          <div className="lecture__card-desc">階層レクチャーや構造学習</div>
        </Link>

        <Link className="lecture__card" href="/knowledge">
          <div className="lecture__card-emoji">❓</div>
          <div className="lecture__card-title">Q＆A</div>
          <div className="lecture__card-desc">アプリの使い方</div>
        </Link>

        <Link className="lecture__card" href="/lecture/q-analysis">
          <div className="lecture__card-emoji">🌀</div>
          <div className="lecture__card-title">Q解析</div>
          <div className="lecture__card-desc">Qコードの記録を可視化する</div>
        </Link>
      </div>
    </div>
  );
}
