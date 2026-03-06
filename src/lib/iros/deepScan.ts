// src/lib/iros/deepScan.ts
// Iros DeepScan — 1ターン分のテキストから
// - Depth(S/F/R/C/I/T の18階層)
// - Phase(Inner/Outer)
// - QCode(Q1〜Q5)
// をざっくり推定する軽量アルゴリズム（V3 fallback）

import type { Depth, QCode } from '@/lib/iros/system';

export type DeepScanResult = {
  depth: Depth | null;
  phase: 'Inner' | 'Outer' | null;
  q: QCode | null;
  intentSummary: string;
};

function norm(text: string): string {
  return (text || '').trim();
}

function compact(text: string): string {
  return norm(text).replace(/\s/g, '');
}

function hasAny(t: string, words: string[]): boolean {
  return words.some((w) => t.includes(w));
}

/* ========= Depth 判定（V3 / 18階層） ========= */

function inferTDepth(text: string): Depth | null {
  const t = compact(text);
  if (!t) return null;

  const t3Words = [
    '根源',
    '源泉',
    '永遠',
    '無限',
    '時間を超えた',
    '静寂',
    '沈黙そのもの',
    '真理そのもの',
    '存在全体',
  ];
  if (hasAny(t, t3Words)) return 'T3';

  const t2Words = [
    '集合意識',
    '全体意識',
    'フィールド',
    '場そのもの',
    '普遍',
    'トランセンデンス',
    '越境',
    '次元を超える',
    '時間を超える',
    '枠を超える',
  ];
  if (hasAny(t, t2Words)) return 'T2';

  const t1Words = [
    '宇宙',
    '宇宙意志',
    '宇宙の意図',
    'ビッグバン',
    '意図フィールド',
    'T層',
    '超えたい',
    '抜け出したい',
    '視座を上げたい',
  ];
  if (hasAny(t, t1Words)) return 'T1';

  return null;
}

function inferIDepth(text: string): Depth | null {
  const t = compact(text);
  if (!t) return null;

  const i3Words = [
    '何のために',
    '何の為に',
    '使命',
    '存在理由',
    '存在意義',
    '生きている意味',
    '生きる意味',
    '生まれてきた意味',
    '生きてきた意味',
    'なぜ生まれた',
    'なぜ生まれてきた',
    'なぜ自分はここにいる',
    '私は何者',
    '自分は何者',
  ];
  if (hasAny(t, i3Words)) return 'I3';

  const i2Words = [
    'どう生きたい',
    '人生',
    '本心',
    '本音',
    '願い',
    '本当にやりたいこと',
    '本当はどうしたい',
    '何を大切にしたい',
    '何を大事にしたい',
    'どう在りたい',
    'どうありたい',
    'なぜこれをやりたい',
    'なぜこれをやろうとしている',
    'そもそもなぜ',
    'そもそも私はなぜ',
  ];
  if (hasAny(t, i2Words)) return 'I2';

  const i1Words = [
    'ありたい姿',
    '在り方',
    'ビジョン',
    '理想像',
    '方向性',
    '自分らしく',
    '本当の自分',
    '自分の軸',
    '意味を整理したい',
    '意図を整理したい',
  ];
  if (hasAny(t, i1Words)) return 'I1';

  return null;
}

function inferCDepth(text: string): Depth | null {
  const t = compact(text);
  if (!t) return null;

  const c3Words = [
    'プロジェクト全体',
    '全体設計',
    '設計思想',
    '構造設計',
    'ロードマップ',
    '戦略',
    '計画',
    '構想全体',
    '世界観設計',
  ];
  if (hasAny(t, c3Words)) return 'C3';

  const c2Words = [
    '仕組み',
    'どう作ればいい',
    'どう組む',
    '実装の構成',
    '構成を整理',
    'どう設計する',
    '設計したい',
    '実装したい',
    '仕様を決めたい',
    '構造を作りたい',
    '作り方を整理したい',
  ];
  if (hasAny(t, c2Words)) return 'C2';

  const c1Words = [
    '作りたい',
    'つくりたい',
    '表現したい',
    '形にしたい',
    '届けたい',
    'やり遂げたい',
    'やりたい',
    'やってみたい',
    '始めたい',
    'スタートしたい',
    '挑戦したい',
    '開発',
    '機能',
    '実装',
    '設計',
    '構成',
  ];
  if (hasAny(t, c1Words)) return 'C1';

  return null;
}

function inferRDepth(text: string): Depth | null {
  const t = compact(text);
  if (!t) return null;

  const r3Words = [
    '境界',
    '距離感',
    '依存',
    '投影',
    '干渉',
    '巻き込まれる',
    'どう感じている',
    'どう思っている',
    '関係の本質',
    '二人の関係',
  ];
  if (hasAny(t, r3Words)) return 'R3';

  const r2Words = [
    '人間関係',
    'チーム',
    '組織',
    '社内',
    '家族',
    'パートナー',
    '友達',
    '上司',
    '部下',
    '同僚',
    '相手',
    '関係',
    '関係性',
  ];
  if (hasAny(t, r2Words)) return 'R2';

  const r1Words = [
    'あの人',
    'あの上司',
    '彼',
    '彼女',
    'みんな',
    '周り',
    '職場',
    '会社',
  ];
  if (hasAny(t, r1Words)) return 'R1';

  return null;
}

function inferFDepth(text: string): Depth | null {
  const t = compact(text);
  if (!t) return null;

  const f3Words = [
    '定着させたい',
    '習慣化したい',
    '続く仕組みにしたい',
    '生活の型にしたい',
    '日常に組み込みたい',
    '維持できる形にしたい',
  ];
  if (hasAny(t, f3Words)) return 'F3';

  const f2Words = [
    '続けられる形',
    '安定させたい',
    '流れを整えたい',
    '日常の流れ',
    '土台を作りたい',
    '無理なく続けたい',
    '崩れにくくしたい',
    'リズムを整えたい',
  ];
  if (hasAny(t, f2Words)) return 'F2';

  const f1Words = [
    '形にしたい',
    '整えたい',
    '続けたい',
    '頻度を決めたい',
    '時間帯を決めたい',
    'ルールを決めたい',
    '習慣',
    '安定',
    '土台',
    'ルーティン',
  ];
  if (hasAny(t, f1Words)) return 'F1';

  return null;
}

function inferSDepth(text: string): Depth | null {
  const t = compact(text);
  if (!t) return null;

  const s3Words = [
    '自分がわからない',
    '自分を責めてしまう',
    '自己否定',
    '自己肯定',
    '本当の気持ち',
    '根っこの気持ち',
    '心の奥',
  ];
  if (hasAny(t, s3Words)) return 'S3';

  const s2Words = [
    'モヤモヤ',
    'イライラ',
    '悲しい',
    'さみしい',
    'しんどい',
    'つらい',
    '疲れた',
    '不安',
    '落ち着かない',
    '自分の状態',
    '今の状態',
    'いまの状態',
  ];
  if (hasAny(t, s2Words)) return 'S2';

  const s1Words = [
    '最近どうしてた',
    '今日はどんな一日',
    '調子',
    '体調',
    '眠い',
    'だるい',
    '整理したい',
    '見直したい',
    '落ち着きたい',
    '今の自分',
    'いまの自分',
    '気持ちに戻りたい',
  ];
  if (hasAny(t, s1Words)) return 'S1';

  return null;
}

function inferDepth(text: string): Depth | null {
  const t = norm(text);
  if (!t) return null;

  const tDepth = inferTDepth(t);
  if (tDepth) return tDepth;

  const iDepth = inferIDepth(t);
  if (iDepth) return iDepth;

  const rDepth = inferRDepth(t);
  if (rDepth) return rDepth;

  const cDepth = inferCDepth(t);
  if (cDepth) return cDepth;

  const fDepth = inferFDepth(t);
  if (fDepth) return fDepth;

  const sDepth = inferSDepth(t);
  if (sDepth) return sDepth;

  // fallback は軽い自己整理
  return 'S1';
}

/* ========= Phase 判定 ========= */

function inferPhase(text: string): 'Inner' | 'Outer' | null {
  const t = norm(text);
  if (!t) return null;

  const innerHit = /(私|自分|わたし|僕|気持ち|心|本音|不安|怖い|つらい|疲れた|しんどい)/.test(t);
  const outerHit = /(上司|部下|同僚|会社|職場|チーム|家族|彼|彼女|相手|お客さん|クライアント)/.test(t);

  if (innerHit && !outerHit) return 'Inner';
  if (!innerHit && outerHit) return 'Outer';
  if (innerHit && outerHit) return 'Inner';

  return null;
}

/* ========= QCode 判定 ========= */

function inferQ(text: string): QCode | null {
  const t = norm(text);
  if (!t) return null;

  const q2 = /(怒|ムカつ|腹が立つ|イライラ|納得できない|許せない|壊したい|変えたい|ぶつかりたい|進めたい|直したい)/;
  const q4 = /(怖い|恐い|恐怖|トラウマ|不安でたまらない|消えたい|逃げたい|終わらせたい|無理)/;
  const q3 = /(不安|心配|大丈夫かな|迷っている|揺れている|モヤモヤ|落ち着かない|ぐるぐる|なんだっけ)/;
  const q1 = /(疲れた|しんどい|休みたい|落ち着きたい|整理したい|守りたい|キャパ|限界|一旦止ま|ブレーキ|確認したい)/;
  const q5 = /(楽しい|楽しみ|ワクワク|わくわく|嬉しい|うれしい|テンション|燃える|やる気|創りたい|表現したい|インスピレーション)/;

  if (q2.test(t)) return 'Q2';
  if (q4.test(t)) return 'Q4';
  if (q3.test(t)) return 'Q3';
  if (q1.test(t)) return 'Q1';
  if (q5.test(t)) return 'Q5';

  return null;
}

/* ========= intentSummary ========= */

function buildIntentSummary(depth: Depth | null): string {
  if (!depth) {
    return '自分の状態や感情の揺れを整理しようとしています。';
  }

  if (depth.startsWith('T')) {
    return '存在全体や意図フィールドの流れと、自分の今を重ね合わせようとしています。';
  }
  if (depth.startsWith('I')) {
    return '生き方や存在意図そのものに静かに触れようとしています。';
  }
  if (depth.startsWith('C')) {
    return 'これからの動きや創造・実装の流れを整えようとしています。';
  }
  if (depth.startsWith('R')) {
    return '誰かとの関係性や場の空気を見つめ直そうとしています。';
  }
  if (depth.startsWith('F')) {
    return '続けられる形や日常の流れを整え、定着しやすい土台を作ろうとしています。';
  }

  return '自分の状態や感情の揺れを整理しようとしています。';
}

/* ========= Public API ========= */

export function deepScan(text: string): DeepScanResult {
  const depth = inferDepth(text);
  const phase = inferPhase(text);
  const q = inferQ(text);
  const intentSummary = buildIntentSummary(depth);

  return {
    depth,
    phase,
    q,
    intentSummary,
  };
}
