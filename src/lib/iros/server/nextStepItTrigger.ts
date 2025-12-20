// src/lib/iros/nextStepOptions.ts
// Iros 「この先の一歩」選択肢生成ロジック
//
// - ギアA：セーフティ（S2に留まる）
// - ギアB：ソフト回転（意志ベクトルだけ上向き）
// - ギアC：フル回転（depthも含めて上げる前提）
//
// ✅ 追加：ITデモ（C/I/T 固定3ボタン）
// - ここで「ボタンとして何を出すか」だけ決める
// - 押した後に “IT言語でガッツリ1ページ” を出すのは renderReply 側（renderMode='IT'）の責務

import type { Depth, IrosMode } from '../system';

/**
 * 三軸ギアのレベル
 */
export type NextStepGear = 'safety' | 'soft-rotate' | 'full-rotate' | 'it-demo';

/**
 * Qコードの簡易型
 */
export type NextStepQCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

/**
 * ✅ ITデモで「どの層から返すか」
 */
export type ItTarget = 'C' | 'I' | 'T';

/**
 * ユーザーに提示する「この先の一歩」オプション
 */
export type NextStepOption = {
  id: string;
  gear: NextStepGear;

  label: string;
  description?: string;

  meta: {
    /** depthの希望 */
    requestedDepth?: Depth;

    /** modeの希望（mirror / vision など） */
    requestedMode?: IrosMode;

    /** goalのニュアンスヒント */
    goalKindHint?: 'uncover' | 'stabilize' | 'forward';

    /** セーフティ関連のフラグ */
    safetyTag?: 'q5_protect' | 'none';

    // ✅ 追加：ITトリガー情報（押したら renderMode='IT' に切り替える材料）
    renderMode?: 'IT';
    itTarget?: ItTarget;
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

export function decideNextStepGear(
  input: DecideNextStepGearInput,
): Exclude<NextStepGear, 'it-demo'> {
  const { qCode, selfAcceptance, hasQ5DepressRisk } = input;

  if (selfAcceptance == null || selfAcceptance < 0.4) return 'safety';
  if (qCode === 'Q5' && hasQ5DepressRisk) return 'safety';
  if (selfAcceptance < 0.7) return 'soft-rotate';
  return 'full-rotate';
}

/* =========================================================
   Normal options (existing)
========================================================= */

function buildSafetyOptions(): NextStepOption[] {
  return [
    {
      id: 'stay_and_talk_more',
      gear: 'safety',
      label: 'もう少し、いまの気持ちを言葉にしてみる',
      description:
        'いま感じていることを、もう少しだけ一緒に整理していくモードです。',
      meta: {
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

export function buildNextStepOptions(params: {
  qCode: NextStepQCode;
  depth: Depth;
  selfAcceptance: number | null;
  hasQ5DepressRisk: boolean;
}): {
  gear: Exclude<NextStepGear, 'it-demo'>;
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
    default:
      options = buildFullRotateOptions();
      break;
  }

  return { gear, options };
}

/* =========================================================
   ✅ IT Demo options (NEW)
   - C / I / T の固定3ボタン
   - 押したら renderMode='IT' に切り替える材料を meta に入れる
========================================================= */

function buildItDemoOptions(): NextStepOption[] {
  return [
    {
      id: 'it_from_c',
      gear: 'it-demo',
      label: 'C層：アイディアを出す',
      description: '具体案を複数並べて、次の一手を組み立てる',
      meta: {
        renderMode: 'IT',
        itTarget: 'C',
        requestedDepth: 'C2' as Depth,
        requestedMode: 'consult' as IrosMode,
        goalKindHint: 'forward',
        safetyTag: 'none',
      },
    },
    {
      id: 'it_from_i',
      gear: 'it-demo',
      label: 'I層：未来から受け取る',
      description: '今の迷いを“構造”として見て、未来の方向へ揃える',
      meta: {
        renderMode: 'IT',
        itTarget: 'I',
        requestedDepth: 'I2' as Depth,
        requestedMode: 'vision' as IrosMode,
        goalKindHint: 'forward',
        safetyTag: 'none',
      },
    },
    {
      id: 'it_from_t',
      gear: 'it-demo',
      label: 'T層：気づきから反転させる',
      description: '意図の核に刺して、現実側（C/F）へ流す',
      meta: {
        renderMode: 'IT',
        itTarget: 'T',
        // TはDepth unionに無い可能性があるので、ここではI2に寄せておく（render側でT扱い）
        requestedDepth: 'I2' as Depth,
        requestedMode: 'vision' as IrosMode,
        goalKindHint: 'forward',
        safetyTag: 'none',
      },
    },
  ];
}

/**
 * meta に nextStep 情報を付け足すヘルパー
 *
 * ✅ 追加方針：
 * - ITデモが欲しい文言なら「C/I/T 固定3ボタン」を優先で出す
 * - それ以外は従来通り「相談っぽい入力」だけ nextStep を出す
 */
export function attachNextStepMeta(params: {
  meta: any;
  qCode: NextStepQCode;
  depth: Depth;
  selfAcceptance: number | null;
  hasQ5DepressRisk: boolean;
  userText: string;
}): any {
  const { meta, qCode, depth, selfAcceptance, hasQ5DepressRisk, userText } =
    params;

  // すでに nextStep があれば何もしない
  if (meta?.nextStep?.options?.length) return meta;

  const text = String(userText ?? '');

  // ✅ ITデモ判定（このどれかが入ってたらC/I/Tボタンを出す）
  const wantsItDemo =
    text.includes('IT') ||
    text.includes('IT層') ||
    text.includes('I層') ||
    text.includes('T層') ||
    text.includes('C層') ||
    text.includes('ITトリガー') ||
    text.includes('IT返し');

  if (wantsItDemo) {
    return {
      ...meta,
      nextStep: {
        gear: 'it-demo' as NextStepGear,
        options: buildItDemoOptions(),
      },
    };
  }

  // 従来：相談入力でだけ nextStep を出す
  const shouldOfferNextStep =
    text.includes('選択肢') ||
    text.includes('決められない') ||
    text.includes('選べない') ||
    text.includes('どうしたらいい');

  if (!shouldOfferNextStep) return meta;

  const built = buildNextStepOptions({
    qCode,
    depth,
    selfAcceptance,
    hasQ5DepressRisk,
  });

  return {
    ...meta,
    nextStep: {
      gear: built.gear,
      options: built.options,
    },
  };
}
