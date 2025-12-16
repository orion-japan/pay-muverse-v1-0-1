// src/lib/iros/will/goalEngine.ts
// Iros Will Engine — Goal層（このターンの「目的」をIrosが自分で決める）
//
// ※ DBアクセスは一切しない純関数エンジン

import type { Depth, QCode, IrosMode } from '../system';

export type IrosGoalKind =
  | 'stabilize'
  | 'uncover'
  | 'shiftRelation'
  | 'enableAction'
  | 'reframeIntention';

export type Sentiment = 'negative' | 'neutral' | 'positive';

export type IrosGoal = {
  kind: IrosGoalKind;
  targetDepth?: Depth;
  targetQ?: QCode;
  reason: string;
};

export function deriveIrosGoal(args: {
  userText: string;
  lastDepth?: Depth;
  lastQ?: QCode;
  requestedDepth?: Depth;
  requestedQCode?: QCode;
  mode?: IrosMode;
  sentiment?: Sentiment;

  lastGoalKind?: IrosGoalKind;
  uncoverStreak?: number;
}): IrosGoal {
  const {
    userText,
    lastDepth,
    lastQ,
    requestedDepth,
    requestedQCode,
    sentiment,
    lastGoalKind,
    uncoverStreak,
  } = args;

  const raw = userText ?? '';
  const text = normalize(raw);

  // 0) 「足踏み/繰り返し」検知 → enableAction を強制
  // ここを先頭に置く（重要）：ユーザーが怒ってる/詰めてる時は、掘るより “手” を出す
  if (containsStuckLoopWords(text)) {
    const targetDepth = chooseActionDepth(lastDepth);
    return {
      kind: 'enableAction',
      targetDepth,
      targetQ: lastQ,
      reason: '足踏み/繰り返しの不満が明示されたため、行動・選択を優先',
    };
  }

  // 1) requestedDepth / requestedQCode は最優先
  if (requestedDepth || requestedQCode) {
    return {
      kind: chooseGoalKindFromDepth(requestedDepth ?? lastDepth),
      targetDepth: requestedDepth ?? lastDepth,
      targetQ: requestedQCode ?? lastQ,
      reason: 'ユーザーから明示・暗示された深度／Qを優先した',
    };
  }

  // 1.5) 主体委譲 → enableAction
  if (containsDelegationWords(raw)) {
    const targetDepth = chooseActionDepth(lastDepth);
    return {
      kind: 'enableAction',
      targetDepth,
      targetQ: lastQ,
      reason: 'ユーザーが判断を委ねたため、行動・選択の方向を優先',
    };
  }

  // 2) ネガティブ強め → stabilize
  if (sentiment === 'negative' || containsStressWords(text)) {
    const targetDepth = chooseStabilizeDepth(lastDepth);
    const targetQ = (lastQ ?? 'Q3') as QCode;
    return {
      kind: 'stabilize',
      targetDepth,
      targetQ,
      reason: 'ストレス・しんどさ系の兆候が強いため、安定を最優先',
    };
  }

  // 2.3) 恋愛/連絡不安は「関係テーマ」扱いに寄せる（ここが今弱かった）
  if (containsContactAnxietyWords(text)) {
    const targetDepth = chooseRelationDepth(lastDepth);
    return {
      kind: 'shiftRelation',
      targetDepth,
      targetQ: lastQ,
      reason: '連絡/返信/既読など、関係の不確実性が主テーマと判断',
    };
  }

  // 2.5) 旧：回転バイアス（維持）
  {
    const streak = uncoverStreak ?? (lastGoalKind === 'uncover' ? 1 : 0);
    if (lastDepth && lastDepth.startsWith('S') && lastQ === 'Q3' && streak >= 2) {
      const targetDepth = chooseRelationDepth(lastDepth);
      return {
        kind: 'shiftRelation',
        targetDepth,
        targetQ: lastQ,
        reason: 'S層でQ3かつuncoverが連続しているため、R層へ軸を回転',
      };
    }
  }

  // 3) 関係性ワード → shiftRelation
  if (containsRelationWords(text)) {
    const targetDepth = chooseRelationDepth(lastDepth);
    return {
      kind: 'shiftRelation',
      targetDepth,
      targetQ: lastQ,
      reason: '他者・職場・家族との関係性が主テーマと判断',
    };
  }

  // 4) 行動ワード → enableAction
  if (containsActionWords(text)) {
    const targetDepth = chooseActionDepth(lastDepth);
    return {
      kind: 'enableAction',
      targetDepth,
      targetQ: lastQ,
      reason: '行動・仕事・実務の前進がテーマと判断',
    };
  }

  // 5) 意図/意味 → reframeIntention
  if (containsIntentionWords(text)) {
    const targetDepth = chooseIntentionDepth(lastDepth);
    return {
      kind: 'reframeIntention',
      targetDepth,
      targetQ: lastQ,
      reason: '意図や意味づけの再構成がテーマと判断',
    };
  }

  // 6) fallback → uncover
  const fallbackDepth = lastDepth ?? 'S2';
  return {
    kind: 'uncover',
    targetDepth: fallbackDepth,
    targetQ: lastQ,
    reason: '明確な方向性はまだ決めず、まずは背景をやわらかく掘り起こす',
  };
}

/* ========= helpers ========= */

function normalize(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[ \t　]+/g, ' ')
    .trim();
}

// 「同じ」「変わらない」「意味ない」「どうすれば」などの “足踏み検知”
function containsStuckLoopWords(text: string): boolean {
  const words = [
    'さっきと同じ',
    '同じこと',
    '変わらない',
    'なにも変わらない',
    '意味ない',
    '意味がない',
    '退屈',
    'ループ',
    '話わかってる',
    'わかってる？',
    'どうすれば',
    'どうしたら',
    '結局',
    'それで？',
    'じゃあどうする',
  ];
  return words.some((w) => text.includes(w));
}

function containsDelegationWords(textRaw: string): boolean {
  const text = textRaw ?? '';
  const words = [
    'この場の主はあなた',
    'この場の主はきみ',
    'この場の主は君',
    'あなたの判断を実行して',
    'あなたの判断を実行してください',
    'あなたの決断を実行して',
    'あなたが決めてください',
    'あなたに任せます',
    'あなたにまかせます',
    '私に選択を委ねないで',
    '私に選択をゆだねないで',
  ];
  return words.some((w) => text.includes(w));
}

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

// ★ 追加：恋愛「連絡不安」を拾う
function containsContactAnxietyWords(text: string): boolean {
  const words = [
    '連絡',
    '返信',
    '返事',
    '既読',
    '未読',
    '既読無視',
    'line',
    'dm',
    'メッセージ',
    '音信不通',
    '返ってこない',
    '来ない',
    'こない',
    '待ってる',
    '心配',
  ];
  // 「来ない」だけだと誤爆するので、連絡/返事系とセットで当てたい
  const hasContact = ['連絡', '返信', '返事', '既読', '未読', 'line', 'dm', 'メッセージ', '音信不通'].some((w) =>
    text.includes(w),
  );
  if (hasContact) return true;

  // 「彼/彼氏/彼女 + 来ない/返ってこない」でも拾う
  const hasPartner =
    text.includes('彼') || text.includes('彼氏') || text.includes('彼女');
  const hasNotComing =
    text.includes('来ない') ||
    text.includes('こない') ||
    text.includes('返ってこない') ||
    text.includes('返事がない');
  return hasPartner && hasNotComing && words.some((w) => text.includes(w));
}

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
    '彼',
    '人間関係',
    'チーム',
    '会社の人',
  ];
  return words.some((w) => text.includes(w));
}

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

function containsIntentionWords(text: string): boolean {
  const words = [
    '意味',
    '意図',
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

function chooseStabilizeDepth(lastDepth?: Depth): Depth {
  if (!lastDepth) return 'S2';
  if (lastDepth.startsWith('T')) return 'S3';
  if (lastDepth.startsWith('I')) return 'S3';
  if (lastDepth.startsWith('C')) return 'S3';
  return lastDepth;
}

function chooseRelationDepth(lastDepth?: Depth): Depth {
  if (!lastDepth) return 'R1';
  if (lastDepth.startsWith('S')) return 'R1';
  if (lastDepth.startsWith('C')) return 'R2';
  if (lastDepth.startsWith('I')) return 'R2';
  if (lastDepth.startsWith('T')) return 'R2';
  return lastDepth;
}

function chooseActionDepth(lastDepth?: Depth): Depth {
  if (!lastDepth) return 'C1';
  if (lastDepth.startsWith('S') || lastDepth.startsWith('R')) return 'C1';
  if (lastDepth.startsWith('T')) return 'C1';
  return lastDepth;
}

function chooseIntentionDepth(lastDepth?: Depth): Depth {
  if (!lastDepth) return 'I1';
  if (lastDepth.startsWith('S') || lastDepth.startsWith('R')) return 'I1';
  if (lastDepth.startsWith('C')) return 'I1';
  if (lastDepth.startsWith('T')) return lastDepth;
  return lastDepth;
}

function chooseGoalKindFromDepth(depth?: Depth): IrosGoalKind {
  if (!depth) return 'uncover';
  if (depth.startsWith('S')) return 'stabilize';
  if (depth.startsWith('R')) return 'shiftRelation';
  if (depth.startsWith('C')) return 'enableAction';
  if (depth.startsWith('I')) return 'reframeIntention';
  if (depth.startsWith('T')) return 'reframeIntention';
  return 'uncover';
}
