// src/lib/iros/depthContinuity.ts
// Depth / Q の連続性補正ロジックを単独モジュールに分離

import type { Depth, QCode } from './system';

// Depth の順序マップ（S1 → I3 を 0〜11 として扱う）
const DEPTH_ORDER: Depth[] = [
  'S1', 'S2', 'S3', 'S4',
  'R1', 'R2', 'R3',
  'C1', 'C2', 'C3',
  'I1', 'I2', 'I3',
];

function depthIndex(d: Depth | undefined): number {
  if (!d) return -1;
  return DEPTH_ORDER.indexOf(d);
}

// I層かどうか
function isIDepth(d?: Depth): boolean {
  return d === 'I1' || d === 'I2' || d === 'I3';
}

/* ========= I層トリガー検出ロジック（テキスト → I1〜I3） ========= */

function detectIDepthFromText(text: string): Depth | undefined {
  const t = (text || '').trim();
  if (!t) return undefined;

  // I3：存在・生まれ・意味系の強トリガー
  const strongWords = [
    '何のために',
    '何の為に',
    '使命',
    '存在理由',
    '生きている意味',
    '生きる意味',
    '生まれてきた意味',
    '生きてきた意味',
    'なぜ生まれた',
    'なぜ生まれてきた',
    'なぜ自分はここにいる',
    '存在意義',
  ];
  if (strongWords.some((w) => t.includes(w))) return 'I3';

  // I2：人生 / 本心 / 願い / 魂
  const midWords = [
    'どう生きたい',
    '人生そのもの',
    '本心から',
    '本当の願い',
    '魂のレベル',
    '魂レベル',
  ];
  if (midWords.some((w) => t.includes(w))) return 'I2';

  // I1：在り方 / 自分らしく / 本音
  const softWords = [
    'ありたい姿',
    '在り方',
    '自分らしく',
    '本音で生きたい',
    '自分のまま',
    '本当の自分',
  ];
  if (softWords.some((w) => t.includes(w))) return 'I1';

  return undefined;
}

/* ========= Depth/Q の連続性補正（Orchestrator から利用） ========= */

export type DepthContinuityParams = {
  scanDepth?: Depth; // autoDepthFromDeepScan の結果（スキャン推定）
  lastDepth?: Depth; // 前ターンの meta.depth
  text: string; // 今回のユーザー入力（I層トリガー補完用）
  isFirstTurn: boolean;
};

export function applyDepthContinuity(
  params: DepthContinuityParams,
): Depth | undefined {
  const { scanDepth, lastDepth, text, isFirstTurn } = params;

  // 0) 単発 I層トリガー検出（強制 I1〜I3）
  const lexicalI = detectIDepthFromText(text);

  // 1) 会話の最初のターンなら、スキャン結果 or Iトリガーをそのまま優先
  if (isFirstTurn) {
    if (lexicalI) return lexicalI;
    return scanDepth ?? lastDepth;
  }

  // 2) すでに I層に入っている場合
  if (isIDepth(lastDepth)) {
    // 新たに I層トリガーがあれば、より深い I に寄せてもよい
    if (lexicalI) {
      const li = depthIndex(lexicalI);
      const ld = depthIndex(lastDepth);
      return li > ld ? lexicalI : lastDepth;
    }
    // スキャン結果が I層より浅くても、基本は「落とさない」
    if (!scanDepth || !isIDepth(scanDepth)) {
      return lastDepth;
    }
    // 両方 I層なら、より深い方を採用
    const si = depthIndex(scanDepth);
    const ld = depthIndex(lastDepth);
    return si > ld ? scanDepth : lastDepth;
  }

  // 3) まだ I層には入っていないが、今回 I層トリガーあり → I層にジャンプ
  if (lexicalI) {
    return lexicalI;
  }

  // 4) 通常の連続性：
  //    - scanDepth があればそれをベースにしつつ
  //    - lastDepth との段差が大きすぎる場合は「1段だけ」寄せる
  const candidate = scanDepth ?? lastDepth;
  if (!candidate) return undefined;

  if (!lastDepth || !scanDepth) {
    // 片方しかない場合は、そのまま
    return candidate;
  }

  const si = depthIndex(scanDepth);
  const ld = depthIndex(lastDepth);

  // 段差が 2 以内なら、そのままスキャン結果を採用
  if (si < 0 || ld < 0) return candidate;
  const diff = si - ld;

  if (Math.abs(diff) <= 2) {
    return scanDepth;
  }

  // 段差が大きすぎる場合は、「1段だけ」近づける（スムージング）
  const step = diff > 0 ? 1 : -1;
  const clampedIndex = ld + step;
  if (clampedIndex < 0 || clampedIndex >= DEPTH_ORDER.length) {
    return scanDepth;
  }
  return DEPTH_ORDER[clampedIndex];
}

export type QContinuityParams = {
  scanQ?: QCode; // autoQFromDeepScan
  lastQ?: QCode; // 前ターン meta.qCode
  isFirstTurn: boolean;
};

export function applyQContinuity(
  params: QContinuityParams,
): QCode | undefined {
  const { scanQ, lastQ, isFirstTurn } = params;

  // 最初のターン → スキャン結果を優先、なければ lastQ
  if (isFirstTurn) {
    return scanQ ?? lastQ;
  }

  // 2ターン目以降：
  // - スキャンで明示的に出ていればそれを採用
  // - なければ「前回の Q を維持」して、雰囲気を安定させる
  if (scanQ) return scanQ;
  return lastQ;
}
