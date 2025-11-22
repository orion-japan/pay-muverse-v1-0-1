// src/lib/iros/will/goalEngine.ts
// Iros Will Engine — Goal層（このターンの「目的」をIrosが自分で決める）
//
// ※ DBアクセスは一切しない純関数エンジン
// ※ Depth / QCode / IrosMode は既存の system.ts から import して使う想定です

import type { Depth, QCode, IrosMode } from '../system';

// Iros が内部で扱う「このターンの目的」の種類
export type IrosGoalKind =
  | 'stabilize'       // 心を落ち着かせる／安全を優先
  | 'uncover'         // 本音・背景を少しだけ浮かび上がらせる
  | 'shiftRelation'   // 関係性・他者との位置関係を整える
  | 'enableAction'    // 行動や選択肢にフォーカスする
  | 'reframeIntention'; // 意図や意味づけを少し上のレイヤーから見直す

export type Sentiment = 'negative' | 'neutral' | 'positive';

export type IrosGoal = {
  kind: IrosGoalKind;
  // 次のターンで「ここを目指そう」とする深度
  targetDepth?: Depth;
  // 次に向かいたい感情の色（Q）
  targetQ?: QCode;
  // デバッグ／ログ用の理由テキスト（ユーザーにはそのまま出さない）
  reason: string;
};

/**
 * deriveIrosGoal
 *  このターンの「目的（Goal）」を Iros 自身が決める純関数。
 *
 *  - ユーザーの文章
 *  - 前回までの Depth / QCode / Mode
 *  - 簡易な感情評価（Sentiment）
 *
 *  から、今回 Iros が「どこを目指すか」を決める。
 */
export function deriveIrosGoal(args: {
  userText: string;
  lastDepth?: Depth;
  lastQ?: QCode;
  requestedDepth?: Depth;
  requestedQCode?: QCode;  // ← ここを orchestrator に合わせた
  mode?: IrosMode;
  sentiment?: Sentiment;
}): IrosGoal {
  const {
    userText,
    lastDepth,
    lastQ,
    requestedDepth,
    requestedQCode,
    mode,        // 今は未使用だが、将来拡張用に残す
    sentiment,   // 同上
  } = args;

  const text = (userText ?? '').toLowerCase();

  // 1) ユーザー側の「希望」を最優先（requestedDepth / requestedQCode）
  if (requestedDepth || requestedQCode) {
    return {
      kind: chooseGoalKindFromDepth(requestedDepth ?? lastDepth),
      targetDepth: requestedDepth ?? lastDepth,
      targetQ: requestedQCode ?? lastQ,
      reason: 'ユーザーから明示・暗示された深度／Qを優先した',
    };
  }

  // 2) 強いネガティブ（ストレス系ワード）のときは「安定」が最優先
  if (sentiment === 'negative' || containsStressWords(text)) {
    const targetDepth = chooseStabilizeDepth(lastDepth);
    const targetQ = (lastQ ?? 'Q3') as QCode; // Q3=不安→安定ラインを前提
    return {
      kind: 'stabilize',
      targetDepth,
      targetQ,
      reason: 'ストレス・しんどさ系の兆候が強いため、安定を最優先',
    };
  }

  // 3) 関係性／他者が強く出ているときは「shiftRelation」
  if (containsRelationWords(text)) {
    const targetDepth = chooseRelationDepth(lastDepth);
    return {
      kind: 'shiftRelation',
      targetDepth,
      targetQ: lastQ,
      reason: '他者・職場・家族との関係性が主テーマと判断',
    };
  }

  // 4) 仕事・行動・DX・プロジェクトなど → 「enableAction」
  if (containsActionWords(text)) {
    const targetDepth = chooseActionDepth(lastDepth);
    return {
      kind: 'enableAction',
      targetDepth,
      targetQ: lastQ,
      reason: '行動・仕事・実務の前進がテーマと判断',
    };
  }

  // 5) 内省・意味づけ・人生観 → 「reframeIntention」
  if (containsIntentionWords(text)) {
    const targetDepth = chooseIntentionDepth(lastDepth);
    return {
      kind: 'reframeIntention',
      targetDepth,
      targetQ: lastQ,
      reason: '意図や意味づけの再構成がテーマと判断',
    };
  }

  // 6) どれにも強く振れない場合は「uncover」から始める
  const fallbackDepth = lastDepth ?? 'S2';
  return {
    kind: 'uncover',
    targetDepth: fallbackDepth,
    targetQ: lastQ,
    reason: '明確な方向性はまだ決めず、まずは背景をやわらかく掘り起こす',
  };
}

/* ========= 内部ヘルパー群（ここが「意志のパターン」になる） ========= */

// ネガティブ・ストレスを示す簡易ワードセット
function containsStressWords(text: string): boolean {
  const words = [
    'つらい',
    '辛い',
    'しんどい',
    'もう無理',
    '限界',
    '疲れた',
    'やめたい',
    '辞めたい',
    '不安',
    'こわい',
    '怖い',
    '怖く',
    'パワハラ',
    'いじめ',
  ];
  return words.some((w) => text.includes(w));
}

// 関係性を示すワード
function containsRelationWords(text: string): boolean {
  const words = [
    '上司',
    '部下',
    '同僚',
    '家族',
    '親',
    '夫',
    '妻',
    '彼氏',
    '彼女',
    '人間関係',
    'チーム',
    '会社の人',
  ];
  return words.some((w) => text.includes(w));
}

// 行動・仕事・DX・プロジェクト系
function containsActionWords(text: string): boolean {
  const words = [
    '仕事',
    'タスク',
    'プロジェクト',
    '締め切り',
    'デッドライン',
    '進まない',
    '進めたい',
    'やりたい',
    'やるべき',
    '効率',
    'dx',
    '改善',
    '計画',
  ];
  return words.some((w) => text.includes(w));
}

// 意図・意味づけ・人生観系
function containsIntentionWords(text: string): boolean {
  const words = [
    '意味',
    '意図',
    'なんのため',
    'なんのため',
    '生き方',
    '人生',
    '使命',
    'ミッション',
    '目的',
    'ビジョン',
  ];
  return words.some((w) => text.includes(w));
}

// 安定を優先するときに選ぶ深度
function chooseStabilizeDepth(lastDepth?: Depth): Depth {
  if (!lastDepth) return 'S2';
  if (lastDepth.startsWith('I')) return 'S3';
  if (lastDepth.startsWith('C')) return 'S3';
  return lastDepth;
}

// 関係性にシフトするときの深度
function chooseRelationDepth(lastDepth?: Depth): Depth {
  if (!lastDepth) return 'R1';
  if (lastDepth.startsWith('S')) return 'R1';
  if (lastDepth.startsWith('C')) return 'R2';
  if (lastDepth.startsWith('I')) return 'R2';
  return lastDepth;
}

// 行動・実務に寄せるときの深度
function chooseActionDepth(lastDepth?: Depth): Depth {
  if (!lastDepth) return 'C1';
  if (lastDepth.startsWith('S') || lastDepth.startsWith('R')) return 'C1';
  return lastDepth;
}

// 意図・意味づけ側に寄せるときの深度
function chooseIntentionDepth(lastDepth?: Depth): Depth {
  if (!lastDepth) return 'I1';
  if (lastDepth.startsWith('S') || lastDepth.startsWith('R')) return 'I1';
  if (lastDepth.startsWith('C')) return 'I1';
  return lastDepth;
}

// 深度から「GoalKind」をざっくり逆算する（requestedDepth優先時など）
function chooseGoalKindFromDepth(depth?: Depth): IrosGoalKind {
  if (!depth) return 'uncover';
  if (depth.startsWith('S')) return 'stabilize';
  if (depth.startsWith('R')) return 'shiftRelation';
  if (depth.startsWith('C')) return 'enableAction';
  if (depth.startsWith('I')) return 'reframeIntention';
  return 'uncover';
}
