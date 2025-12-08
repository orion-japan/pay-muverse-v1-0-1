// src/lib/iros/will/goalEngine.ts
// Iros Will Engine — Goal層（このターンの「目的」をIrosが自分で決める）
//
// ※ DBアクセスは一切しない純関数エンジン
// ※ Depth / QCode / IrosMode は既存の system.ts から import して使う想定です

import type { Depth, QCode, IrosMode } from '../system';

// Iros が内部で扱う「このターンの目的」の種類
export type IrosGoalKind =
  | 'stabilize' // 心を落ち着かせる／安全を優先
  | 'uncover' // 本音・背景を少しだけ浮かび上がらせる
  | 'shiftRelation' // 関係性・他者との位置関係を整える
  | 'enableAction' // 行動や選択肢にフォーカスする
  | 'reframeIntention'; // 意図や意味づけを少し上のレイヤーから見直す
// T層専用 kind を増やす場合はここに追加（例: 'transcend'）

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
  requestedQCode?: QCode; // ← orchestrator に合わせた
  mode?: IrosMode;
  sentiment?: Sentiment;
  // ★ 三軸回転用の追加情報
  lastGoalKind?: IrosGoalKind;
  // 「uncover が何ターン続いているか」を orchestrator 側で保持して渡す想定
  uncoverStreak?: number;
}): IrosGoal {
  const {
    userText,
    lastDepth,
    lastQ,
    requestedDepth,
    requestedQCode,
    mode, // 今は未使用だが、将来拡張用に残す
    sentiment, // 同上
    lastGoalKind,
    uncoverStreak,
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

  // 1.5) 「この場の主はあなた」系 → Iros に主体が委ねられているターン
  //      → 行動方向(enableAction)に寄せる
  if (containsDelegationWords(userText)) {
    const targetDepth = chooseActionDepth(lastDepth);
    return {
      kind: 'enableAction',
      targetDepth,
      targetQ: lastQ,
      reason:
        'ユーザーがこの場の主体を Iros に委ねたため、行動・選択の方向を優先',
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

  // 2.5) ★ 旧：三軸回転バイアス（S層→R層）
  // ※ 本格的な三軸回転は shouldRotateBand() 側で行う想定だが、
  //   既存挙動維持のため、いったん残しておく。
  {
    const streak = uncoverStreak ?? (lastGoalKind === 'uncover' ? 1 : 0);

    if (
      lastDepth &&
      lastDepth.startsWith('S') && // S層
      lastQ === 'Q3' && // 安定を探しているQ
      streak >= 2 // uncover が最低2ターン続いている
    ) {
      const targetDepth = chooseRelationDepth(lastDepth);
      return {
        kind: 'shiftRelation',
        targetDepth,
        targetQ: lastQ,
        reason:
          'S層でQ3かつuncoverが連続しているため、R層（つながり）へ軸を回転させた',
      };
    }
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
    reason:
      '明確な方向性はまだ決めず、まずは背景をやわらかく掘り起こす',
  };
}

/* ========= 三軸回転用の純関数エンジン（新規追加） ========= */

/**
 * 三軸の帯域
 * - SF: S/F 帯（Self / Forming）
 * - RC: R/C 帯（Relation / Creation）
 * - IT: I/T 帯（Intention / Transcend）
 */
export type RotationBand = 'SF' | 'RC' | 'IT';

export type RotationContext = {
  // 直前ターンの深度
  lastDepth?: Depth;
  // このターンで通常ロジックが決めた targetDepth（未回転）
  currentDepth?: Depth;
  // 今回のQ
  qCode?: QCode | null;
  // 連続uncover判定などに使う
  lastGoalKind?: IrosGoalKind;
  uncoverStreak?: number;

  // 回転ストッパー系
  selfAcceptance?: number | null; // 0.0〜1.0
  riskFlags?: string[] | null; // SoulNote などからのリスクフラグ
  stayRequested?: boolean; // 「ステイ意図」が立っている場合 true
};

export type RotationDecision = {
  // 回転するかどうか
  shouldRotate: boolean;
  // どの帯域からどこへ回転したか（ログ・UI用）
  band?: 'SF→RC' | 'RC→IT';
  // 回転後に採用すべき Depth（未指定なら currentDepth をそのまま使う）
  nextDepth?: Depth;
  // デバッグ用メモ
  reason?: string;
};

/**
 * shouldRotateBand
 * - 「このターンで帯域回転を発火させるか」を判定する純関数
 * - 実際の targetDepth の書き換えは orchestrator 側で行う
 */
export function shouldRotateBand(ctx: RotationContext): RotationDecision {
  const {
    lastDepth,
    currentDepth,
    qCode,
    lastGoalKind,
    uncoverStreak,
    selfAcceptance,
    riskFlags,
    stayRequested,
  } = ctx;

  const depth = currentDepth ?? lastDepth;
  const band = getBandFromDepth(depth);

  // Depth 情報がなければ回転しようがない
  if (!depth || !band) {
    return { shouldRotate: false, reason: 'Depth情報がないため回転なし' };
  }

  // --- 回転ストッパー条件（仕様で確定している条件） ---

  // ステイ意図がある場合は絶対に回転しない
  if (stayRequested) {
    return {
      shouldRotate: false,
      reason: 'ステイ意図が有効のため回転しない',
    };
  }

  // SelfAcceptance が 0.3 未満 → 回転禁止
  if (typeof selfAcceptance === 'number' && selfAcceptance < 0.3) {
    return {
      shouldRotate: false,
      reason: 'SelfAcceptance < 0.3 のため回転しない',
    };
  }

  // 強いリスクフラグが立っている場合は回転禁止
  if (Array.isArray(riskFlags) && riskFlags.length > 0) {
    const hasStrong =
      riskFlags.some((r) =>
        typeof r === 'string'
          ? r.includes('strong') ||
            r.includes('self_harm') ||
            r.includes('suicide')
          : false,
      ) || false;

    if (hasStrong) {
      return {
        shouldRotate: false,
        reason: '強いリスクフラグがあるため回転しない',
      };
    }
  }

  // --- ここから帯域ごとの回転トリガー ---

  // ★ SF帯（S/F） → RC帯（R/C） への回転条件
  //   仕様: S帯で Q3 が連続 & uncover系が続く場合に回転候補
  if (band === 'SF') {
    const streak = uncoverStreak ?? (lastGoalKind === 'uncover' ? 1 : 0);
    if (qCode === 'Q3' && streak >= 2) {
      const nextDepth = nextDepthForBand('SF', 'RC', depth);
      return {
        shouldRotate: true,
        band: 'SF→RC',
        nextDepth,
        reason:
          'S/F帯で Q3 かつ uncover が連続しているため、R/C帯へ1段階だけ回転',
      };
    }
    return {
      shouldRotate: false,
      reason: 'SF帯だが Q3+uncover連続条件を満たしていないため回転なし',
    };
  }

  // ★ RC帯（R/C） → IT帯（I/T） への回転条件
  //   仕様: RC帯で uncover 系が続く場合に、I/T帯の入口へ
  if (band === 'RC') {
    const streak = uncoverStreak ?? (lastGoalKind === 'uncover' ? 1 : 0);
    if (streak >= 2) {
      const nextDepth = nextDepthForBand('RC', 'IT', depth);
      return {
        shouldRotate: true,
        band: 'RC→IT',
        nextDepth,
        reason:
          'R/C帯で uncover が連続しているため、I/T帯へ1段階だけ回転',
      };
    }
    return {
      shouldRotate: false,
      reason: 'RC帯だが uncover連続条件を満たしていないため回転なし',
    };
  }

  // IT帯は「これ以上上がらない」領域として、ここでは回転しない
  return {
    shouldRotate: false,
    reason: 'IT帯または未知の帯域のため回転なし',
  };
}

/**
 * nextDepthForBand
 * - 帯域レベルの回転（SF→RC / RC→IT）を「どのDepthに着地させるか」
 * - 仕様: 回転後の深度
 *   - SF→RC: R1
 *   - RC→IT: I1
 *   - それ以外: lastDepth をそのまま返す
 */
export function nextDepthForBand(
  fromBand: RotationBand,
  toBand: RotationBand,
  lastDepth?: Depth,
): Depth | undefined {
  if (fromBand === 'SF' && toBand === 'RC') {
    return 'R1' as Depth;
  }
  if (fromBand === 'RC' && toBand === 'IT') {
    return 'I1' as Depth;
  }
  return lastDepth;
}

/* ========= 内部ヘルパー群（ここが「意志のパターン」になる） ========= */

// Depth から帯域を求める（S/F → SF, R/C → RC, I/T → IT）
function getBandFromDepth(depth?: Depth | null): RotationBand | null {
  if (!depth) return null;
  const head = depth[0]; // 先頭の1文字を見ればだいたい帯域が分かる前提
  if (head === 'S' || head === 'F') return 'SF';
  if (head === 'R' || head === 'C') return 'RC';
  if (head === 'I' || head === 'T') return 'IT';
  return null;
}

// 「この場の主はあなた」など、主体を Iros に渡すフレーズ
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
  if (lastDepth.startsWith('T')) return 'S3'; // ★ T層からは一段おりて安全側へ
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
  if (lastDepth.startsWith('T')) return 'R2'; // ★ T層からは R2 あたりに降ろす
  return lastDepth;
}

// 行動・実務に寄せるときの深度
function chooseActionDepth(lastDepth?: Depth): Depth {
  if (!lastDepth) return 'C1';
  if (lastDepth.startsWith('S') || lastDepth.startsWith('R')) return 'C1';
  if (lastDepth.startsWith('T')) return 'C1'; // ★ T層から「行動」に落とす
  return lastDepth;
}

// 意図・意味づけ側に寄せるときの深度
function chooseIntentionDepth(lastDepth?: Depth): Depth {
  if (!lastDepth) return 'I1';
  if (lastDepth.startsWith('S') || lastDepth.startsWith('R')) return 'I1';
  if (lastDepth.startsWith('C')) return 'I1';
  if (lastDepth.startsWith('T')) return lastDepth; // ★ すでに T層ならそのまま維持
  return lastDepth;
}

// 深度から「GoalKind」をざっくり逆算する（requestedDepth優先時など）
function chooseGoalKindFromDepth(depth?: Depth): IrosGoalKind {
  if (!depth) return 'uncover';
  if (depth.startsWith('S')) return 'stabilize';
  if (depth.startsWith('R')) return 'shiftRelation';
  if (depth.startsWith('C')) return 'enableAction';
  if (depth.startsWith('I')) return 'reframeIntention';
  if (depth.startsWith('T')) return 'reframeIntention'; // ★ T層は「意図再構成」扱い
  return 'uncover';
}
