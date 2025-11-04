'use client';
import React from 'react';
import Image from 'next/image';

/* ==============================
   Love Structure 7 — 動物カード
============================== */

// LS7性格タイプの識別子
export type LS7Id =
  | 'CHASER'
  | 'AVOIDER'
  | 'CARETAKER'
  | 'IDEALIST'
  | 'CONTROLLER'
  | 'DEPENDENT'
  | 'FREE_SPIRIT';

// LS7カード全体構造
export type LS7View = {
  top: LS7Id;
  hits?: string[];
};

// 各動物データ
const LS7_ANIMALS: Record<LS7Id, { jp: string; emoji: string; img: string; oneLine: string }> = {
  DEPENDENT: {
    jp: '甘えすぎるネコ',
    emoji: '🐱',
    img: '/ls7_neko.png',
    oneLine: 'つながりの確認で安心する。',
  },
  CARETAKER: {
    jp: '世話焼きすぎるキツネ',
    emoji: '🦊',
    img: '/ls7_kitune.png',
    oneLine: '関係のバランスを整えたくなる。',
  },
  AVOIDER: {
    jp: '考えすぎるウサギ',
    emoji: '🐇',
    img: '/ls7_usagi.png',
    oneLine: '自由と余白があるほど落ち着く。',
  },
  IDEALIST: {
    jp: '理想高すぎるハト',
    emoji: '🕊️',
    img: '/ls7_hato.png',
    oneLine: 'ロマンと理想像で関係を見る。',
  },
  CONTROLLER: {
    jp: '我慢しすぎるヘビ',
    emoji: '🐍',
    img: '/ls7_hebi.png',
    oneLine: '枠組み・約束・手順で安心する。',
  },
  FREE_SPIRIT: {
    jp: '忙しすぎるリス',
    emoji: '🐿️',
    img: '/ls7_risu.png',
    oneLine: '自己探求と自由度を大切にする。',
  },
  CHASER: {
    jp: '見抜きすぎるドラゴン',
    emoji: '🐉',
    img: '/ls7_dora.png',
    oneLine: '距離が出ると繋ぎ直しに動く。',
  },
};

// =====================================
// メインコンポーネント
// =====================================
export default function LS7Card({ view, qCode }: { view: LS7View; qCode: string }) {
  if (!view?.top) return null;
  const v = LS7_ANIMALS[view.top];

  return (
    <div className="card ls7">
      <div className="ls7__head">
        <Image
          className="ls7__img"
          src={v.img}
          alt={v.jp}
          width={120}
          height={120}
          style={{ borderRadius: '12px', objectFit: 'cover' }}
          onError={(e) => (e.currentTarget.style.display = 'none')}
        />
        <div className="ls7__title">
          <div className="ls7__eyebrow">Love Structure 7</div>
          <h2 className="ls7__h2">
            {v.emoji} {v.jp}（{view.top}）
          </h2>
          <p className="ls7__one">{v.oneLine}</p>
        </div>
      </div>

      <div className="ls7__meta">
        <span className="ls7__pill">Qコード: {qCode}</span>
        {view.hits?.length ? (
          <span className="ls7__hits">根拠: {view.hits.slice(0, 5).join('・')}</span>
        ) : null}
      </div>
    </div>
  );
}
