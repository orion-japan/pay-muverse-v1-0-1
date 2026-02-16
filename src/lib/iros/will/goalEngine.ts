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
  if (containsStuckLoopWords(text)) {
    const targetDepth = chooseActionDepth(lastDepth);
    return {
      kind: 'enableAction',
      targetDepth,
      targetQ: undefined,
      reason: '足踏み/繰り返しの不満が明示されたため、行動・選択を優先',
    };
  }

  // 1) requestedDepth / requestedQCode は最優先
  if (requestedDepth || requestedQCode) {
    return {
      kind: chooseGoalKindFromDepth(requestedDepth ?? lastDepth),
      targetDepth: requestedDepth ?? lastDepth,
      targetQ: requestedQCode ?? undefined,
      reason: 'ユーザーから明示・暗示された深度／Qを優先した',
    };
  }

  // 1.5) 主体委譲 → enableAction
  if (containsDelegationWords(raw)) {
    const targetDepth = chooseActionDepth(lastDepth);
    return {
      kind: 'enableAction',
      targetDepth,
      targetQ: undefined,
      reason: 'ユーザーが判断を委ねたため、行動・選択の方向を優先',
    };
  }

  // 2) ネガティブ強め → stabilize
  if (sentiment === 'negative' || containsStressWords(text)) {
    const targetDepth = chooseStabilizeDepth(lastDepth);
    const targetQ: QCode = 'Q3';
    return {
      kind: 'stabilize',
      targetDepth,
      targetQ,
      reason: 'ストレス・しんどさ系の兆候が強いため、安定を最優先',
    };
  }

  // 2.3) 連絡/恋愛不安 → shiftRelation
  if (containsContactAnxietyWords(text)) {
    const targetDepth = chooseRelationDepth(lastDepth);
    return {
      kind: 'shiftRelation',
      targetDepth,
      targetQ: lastQ,
      reason: '連絡/返信など、関係の不確実性が主テーマと判断',
    };
  }

  // 2.5) uncover 連続バイアス回避
  {
    const streak = uncoverStreak ?? (lastGoalKind === 'uncover' ? 1 : 0);
    if (lastDepth && lastDepth.startsWith('S') && lastQ === 'Q3' && streak >= 2) {
      const targetDepth = chooseRelationDepth(lastDepth);
      return {
        kind: 'shiftRelation',
        targetDepth,
        targetQ: lastQ,
        reason: 'S層でQ3かつuncoverが連続しているため、R層へ回転',
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

  // ★ 3.5) コミット宣言 → enableAction（今回の核心修正）
  if (containsCommitmentWords(text)) {
    const targetDepth = chooseActionDepth(lastDepth);
    return {
      kind: 'enableAction',
      targetDepth,
      targetQ: lastQ,
      reason: '「選ぶ／決めた／理由はある」等のコミット宣言が検出されたため、次の一手を優先',
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

  // 5.2) 雑談（smalltalk） → stabilize（ライト）
  // - uncover の落ち先にしない
  if (isSmallTalk(text)) {
    const targetDepth = chooseStabilizeDepth(lastDepth);
    return {
      kind: 'stabilize',
      targetDepth,
      targetQ: lastQ ?? 'Q2',
      reason: '雑談（天気/食事/挨拶/近況）と判断したため、軽く整える（uncoverには落とさない）',
    };
  }

  // 5.5) 明示的に「掘る」宣言がある場合のみ uncover
  if (containsUncoverWords(text)) {
    const fallbackDepth = lastDepth ?? 'S2';
    return {
      kind: 'uncover',
      targetDepth: fallbackDepth,
      targetQ: lastQ,
      reason: 'ユーザーが深掘り意図（掘る/原因/根本/未消化等）を明示したため',
    };
  }

  // 6) fallback（デフォルトは stabilize）
  {
    const targetDepth = chooseStabilizeDepth(lastDepth);
    return {
      kind: 'stabilize',
      targetDepth,
      targetQ: lastQ ?? 'Q2',
      reason: '明示トリガーが無いため、まずは整えて流れを保つ（uncoverはデフォルトにしない）',
    };
  }
}

/* ========= helpers ========= */

function normalize(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[ \t　]+/g, ' ')
    .trim();
}

// ---- A: smalltalk detector ----
// 目的：雑談を uncover に落とさない（fallback を stabilize に寄せる）
//
// 方針：
// - 短文 + 挨拶/天気/食事/近況/雑談宣言 などを拾う
// - ただし「掘る/原因/根本…」が入っていたら smalltalk 扱いしない
function isSmallTalk(text: string): boolean {
  if (!text) return false;

  // 「掘る」系が入ってるなら smalltalk にしない
  if (containsUncoverWords(text)) return false;

  const t = text;

  const hasSmallTalkSignals = [
    // 雑談宣言
    '雑談',
    'おしゃべり',
    '話そう',
    '話します',
    '話したい',
    // 挨拶
    'こんにちは',
    'こんばんは',
    'おはよう',
    'はじめまして',
    'よろしく',
    'ありがとう',
    'おつかれ',
    'お疲れ',
    // 天気
    '天気',
    '晴れ',
    '雨',
    '曇',
    '雪',
    '寒い',
    '暑い',
    '涼しい',
    // 食事
    '夕食',
    '昼食',
    '朝食',
    'ごはん',
    'ご飯',
    '食べ',
    '飲み',
    // 近況
    '今日',
    'いま',
    '最近',
    '近況',
    '元気',
  ].some((w) => t.includes(w));

  // かなり短い文は雑談寄りに扱う（例：「今日はいい天気」等）
  const shortLen = t.length <= 28;

  // 質問であっても雑談系（例：「今日の夕食なにがいい？」）は smalltalk に入れてよい
  return hasSmallTalkSignals && (shortLen || true);
}

function containsUncoverWords(text: string): boolean {
  const words = [
    // 掘る宣言
    '掘る',
    '深掘',
    '深ぼ',
    '深く見',
    '深くみ',
    // 原因探索
    '原因',
    '理由',
    '根本',
    '本質',
    '正体',
    '裏側',
    '背景',
    '構造',
    // 未消化・引っかかり
    '未消化',
    '引っかか',
    '引っ掛か',
    'モヤモヤ',
    'もやもや',
    '違和感',
    // トラウマ/過去
    'トラウマ',
    '過去',
    '昔の',
    '幼少',
    // 解除/癒し系（深掘り意図の合図として扱う）
    '手放し',
    '浄化',
    '解放',
  ];
  return words.some((w) => text.includes(w));
}

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
    'わかってる',
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
    'あなたが決めて',
    'あなたに任せる',
    'あなたにまかせる',
    '判断を委ねる',
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
    '不安',
    '怖い',
    'こわい',
  ];
  return words.some((w) => text.includes(w));
}

function containsContactAnxietyWords(text: string): boolean {
  const hasContact = ['連絡', '返信', '既読', '未読', 'line', 'dm', 'メッセージ'].some((w) =>
    text.includes(w),
  );
  const hasNotComing =
    text.includes('来ない') ||
    text.includes('返ってこない') ||
    text.includes('返事がない');
  return hasContact && hasNotComing;
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
    '彼',
    '彼氏',
    '彼女',
    '人間関係',
  ];
  return words.some((w) => text.includes(w));
}

function containsActionWords(text: string): boolean {
  const words = [
    '仕事',
    'タスク',
    'プロジェクト',
    '締め切り',
    '進めたい',
    'やりたい',
    'やるべき',
    '計画',
    '改善',
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
    '目的',
    'ビジョン',
  ];
  return words.some((w) => text.includes(w));
}

// ★ 核心：コミット宣言検知
function containsCommitmentWords(text: string): boolean {
  const hasDecision =
    text.includes('選ぶ') ||
    text.includes('選び') ||
    text.includes('決め') ||
    text.includes('決ま');

  const hasCommitSignal =
    text.includes('やめない') ||
    text.includes('止めない') ||
    text.includes('続け') ||
    text.includes('理由') ||
    text.includes('覚悟') ||
    text.includes('腹をくく') ||
    text.includes('腹を括');

  const reasonAndDecided =
    text.includes('理由') && (text.includes('決め') || text.includes('決ま'));

  const chooseAndNotStop =
    (text.includes('選ぶ') || text.includes('選び')) &&
    (text.includes('やめない') || text.includes('止めない'));

  return (hasDecision && hasCommitSignal) || reasonAndDecided || chooseAndNotStop;
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
