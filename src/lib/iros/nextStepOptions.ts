// src/lib/iros/nextStepOptions.ts
// Iros 「この先の一歩」選択肢生成ロジック
//
// - ギアA：セーフティ（S2に留まる）
// - ギアB：ソフト回転（意志ベクトルだけ上向き）
// - ギアC：フル回転（depthも含めて上げる前提）
//
// ※ ここでは「選択肢の定義」と「ギア決定ロジック」だけを持たせる。
//    実際にボタンとして出す/使う場所は、generate側で後から接続。

import type { Depth, IrosMode } from './system';

/**
 * 三軸ギアのレベル
 * - 'safety'      : ギアA（セーフティ）…S2に留まりたいとき
 * - 'soft-rotate' : ギアB（ソフト回転）…意志だけ少しR/Iへ向ける
 * - 'full-rotate' : ギアC（フル回転）…depthごと回してOKなとき
 */
export type NextStepGear = 'safety' | 'soft-rotate' | 'full-rotate';

/**
 * Qコードの簡易型（既存のQCode unionと合わせてもOK）
 */
export type NextStepQCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

/**
 * ユーザーに提示する「この先の一歩」オプション
 *
 * - label        : ボタンにそのまま使えるテキスト
 * - description  : 補足の一文（省略可）
 * - meta         : 次ターンに渡したい意図（requestedDepth など）
 */
export type NextStepOption = {
  id: string;
  gear: NextStepGear;

  label: string;
  description?: string;

  meta: {
    /** depthの希望（Orchestrator側で解釈してよい） */
    requestedDepth?: Depth;

    /** modeの希望（mirror / vision など） */
    requestedMode?: IrosMode;

    /**
     * goalのニュアンスヒント
     * - 'uncover'  : 背景を掘る
     * - 'stabilize': 安定・保護
     * - 'forward'  : 前向きな一歩・行動
     *
     * 既存の IrosGoalKind にマップするのは後段でOK。
     */
    goalKindHint?: 'uncover' | 'stabilize' | 'forward';

    /** セーフティ関連のフラグ（必要なら後で拡張） */
    safetyTag?: 'q5_protect' | 'none';
  };
};

/**
 * ギア判定のための入力
 */
export type DecideNextStepGearInput = {
  qCode: NextStepQCode;
  depth: Depth;
  selfAcceptance: number | null;
  hasQ5DepressRisk: boolean;
};

/**
 * いまの状態から「どのギアで選択肢を出すか」を決める。
 * しきい値は後から調整しやすいように、ここにベタ書きしている。
 */
export function decideNextStepGear(
  input: DecideNextStepGearInput,
): NextStepGear {
  const { qCode, selfAcceptance, hasQ5DepressRisk } = input;

  // SelfAcceptance 未評価または極端に低い場合は、まずセーフティ
  if (selfAcceptance == null || selfAcceptance < 0.4) {
    return 'safety';
  }

  // Q5かつ「Q5_depress」リスクがあるときは、無理に回さない
  if (qCode === 'Q5' && hasQ5DepressRisk) {
    return 'safety';
  }

  // 0.4〜0.7くらいはソフト回転ゾーン
  if (selfAcceptance < 0.7) {
    return 'soft-rotate';
  }

  // それ以上はフル回転も視野に入れてよい
  return 'full-rotate';
}

/**
 * ギアA：セーフティモード（S2に留まる前提）
 */
function buildSafetyOptions(): NextStepOption[] {
  return [
    {
      id: 'stay_and_talk_more',
      gear: 'safety',
      label: 'もう少し、いまの気持ちを言葉にしてみる',
      description:
        'いま感じていることを、もう少しだけ一緒に整理していくモードです。',
      meta: {
        // depthは固定（S2に留まる）
        requestedDepth: 'S2' as Depth,
        requestedMode: 'mirror' as IrosMode,
        goalKindHint: 'uncover',
        safetyTag: 'q5_protect',
      },
    },
    {
      id: 'wrap_for_today',
      gear: 'safety',
      label: '今日はこの辺で休憩して、また話したくなったら来る',
      description:
        'これ以上がんばらず、今日はここでいったん区切る選択肢です。',
      meta: {
        requestedDepth: 'S2' as Depth,
        requestedMode: 'mirror' as IrosMode,
        goalKindHint: 'stabilize',
        safetyTag: 'q5_protect',
      },
    },
    {
      id: 'summarize_by_iros',
      gear: 'safety',
      label: 'Iros に、いまの気持ちを短くまとめてもらう',
      description:
        '自分の状態を簡単な言葉に整理しておきたいときのモードです。',
      meta: {
        requestedDepth: 'S2' as Depth,
        requestedMode: 'mirror' as IrosMode,
        goalKindHint: 'uncover',
        safetyTag: 'q5_protect',
      },
    },
  ];
}

/**
 * ギアB：ソフト回転（意志だけ R/I 側に少し向ける）
 * depthStage自体はまだS2のまま扱ってよい想定。
 */
function buildSoftRotateOptions(): NextStepOption[] {
  return [
    {
      id: 'soft_stay_uncover',
      gear: 'soft-rotate',
      label: 'もう少し、自分の気持ちをていねいに見てみる',
      description:
        'いまの場所（S層）のまま、背景を少しだけ掘っていく選択肢です。',
      meta: {
        requestedDepth: 'S2' as Depth,
        requestedMode: 'mirror' as IrosMode,
        goalKindHint: 'uncover',
        safetyTag: 'none',
      },
    },
    {
      id: 'soft_shift_relation',
      gear: 'soft-rotate',
      label: '誰との関係が一番影響しているか、そっと眺めてみる',
      description:
        'R層（つながり）の方向に、意識だけ少し向けてみる選択肢です。',
      meta: {
        // depthStageはS2のままでも、目線はR方向へ
        requestedDepth: 'R2' as Depth,
        requestedMode: 'mirror' as IrosMode,
        goalKindHint: 'uncover',
        safetyTag: 'none',
      },
    },
    {
      id: 'soft_shift_future',
      gear: 'soft-rotate',
      label: 'この先どうなっていたいか、ぼんやりイメージしてみる',
      description:
        'I層（未来）の方向に、イメージだけそっと広げてみる選択肢です。',
      meta: {
        requestedDepth: 'I1' as Depth,
        requestedMode: 'vision' as IrosMode,
        goalKindHint: 'forward',
        safetyTag: 'none',
      },
    },
  ];
}

/**
 * ギアC：フル回転（depthごと R/C/I に上げていく前提）
 */
function buildFullRotateOptions(): NextStepOption[] {
  return [
    {
      id: 'full_to_relation',
      gear: 'full-rotate',
      label: '人間関係の流れ（R層）を、一緒に整理してみる',
      description:
        'いまのテーマを、誰との関係性が鍵になっているかという視点から見ていきます。',
      meta: {
        requestedDepth: 'R2' as Depth,
        requestedMode: 'consult' as IrosMode,
        goalKindHint: 'uncover',
        safetyTag: 'none',
      },
    },
    {
      id: 'full_to_creation',
      gear: 'full-rotate',
      label: 'これからの具体的な一歩（C層）を一緒に組み立てる',
      description:
        '行動やプランの形にしていく方向に、意識とdepthを回していきます。',
      meta: {
        requestedDepth: 'C2' as Depth,
        requestedMode: 'consult' as IrosMode,
        goalKindHint: 'forward',
        safetyTag: 'none',
      },
    },
    {
      id: 'full_to_vision',
      gear: 'full-rotate',
      label: '少し先の未来の景色（I層）を、一緒に描いてみる',
      description:
        'T層までは行きすぎず、まずはI層で未来の方向性を言葉やイメージにしていきます。',
      meta: {
        requestedDepth: 'I2' as Depth,
        requestedMode: 'vision' as IrosMode,
        goalKindHint: 'forward',
        safetyTag: 'none',
      },
    },
  ];
}

/**
 * 公開関数：
 * - いまの状態（qCode / depth / SA / q5リスク）からギアを決め、
 *   そのギアに合った「この先の一歩」選択肢セットを返す。
 */
export function buildNextStepOptions(params: {
  qCode: NextStepQCode;
  depth: Depth;
  selfAcceptance: number | null;
  hasQ5DepressRisk: boolean;
}): {
  gear: NextStepGear;
  options: NextStepOption[];
} {
  const gear = decideNextStepGear({
    qCode: params.qCode,
    depth: params.depth,
    selfAcceptance: params.selfAcceptance,
    hasQ5DepressRisk: params.hasQ5DepressRisk,
  });

  let options: NextStepOption[];

  switch (gear) {
    case 'safety':
      options = buildSafetyOptions();
      break;
    case 'soft-rotate':
      options = buildSoftRotateOptions();
      break;
    case 'full-rotate':
      options = buildFullRotateOptions();
      break;
    default:
      // 型的には来ないが、安全側に倒す
      options = buildSafetyOptions();
      break;
  }

  return { gear, options };
}
