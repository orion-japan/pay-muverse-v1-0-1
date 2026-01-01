// src/lib/iros/nextStepOptions.ts
// iros - NextStep options (single source of truth)
//
// - ギアA：セーフティ（S2に留まる）
// - ギアB：ソフト回転（意志ベクトルだけ上向き）
// - ギアC：フル回転（depthも含めて上げる前提）
//
// ✅ ITデモ（C/I/T 固定3ボタン）もここで管理する。
//    「押したら IT言語を出す」の実体は renderReply 側（renderMode='IT'）責務。
//    ここは “ボタン定義と付与meta” だけ。

import type { Depth, IrosMode } from './system';

/**
 * 三軸ギアのレベル
 * - 'safety'      : ギアA（セーフティ）
 * - 'soft-rotate' : ギアB（ソフト回転）
 * - 'full-rotate' : ギアC（フル回転）
 * - 'it-demo'     : ITデモ（固定3ボタン）
 */
export type NextStepGear = 'safety' | 'soft-rotate' | 'full-rotate' | 'it-demo';

/**
 * Qコードの簡易型（既存のQCode unionと合わせてもOK）
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
    /** depthの希望（Orchestrator側で解釈してよい） */
    requestedDepth?: Depth;

    /** modeの希望（mirror / vision / consult など） */
    requestedMode?: IrosMode;

    /**
     * goalのニュアンスヒント
     * - 'uncover'  : 背景を掘る
     * - 'stabilize': 安定・保護
     * - 'forward'  : 前向きな一歩・行動
     */
    goalKindHint?: 'uncover' | 'stabilize' | 'forward';

    /** セーフティ関連のフラグ（必要なら後で拡張） */
    safetyTag?: 'q5_protect' | 'none';

    // ✅ ITトリガー情報（押したら renderMode='IT' に切り替える材料）
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

/**
 * いまの状態から「どのギアで選択肢を出すか」を決める。
 * しきい値は後から調整しやすいように、ここにベタ書きしている。
 */
export function decideNextStepGear(
  input: DecideNextStepGearInput,
): Exclude<NextStepGear, 'it-demo'> {
  const { qCode, selfAcceptance, hasQ5DepressRisk } = input;

  // SelfAcceptance 未評価または極端に低い場合は、まずセーフティ
  if (selfAcceptance == null || selfAcceptance < 0.4) return 'safety';

  // Q5かつ「Q5_depress」リスクがあるときは、無理に回さない
  if (qCode === 'Q5' && hasQ5DepressRisk) return 'safety';

  // 0.4〜0.7くらいはソフト回転ゾーン
  if (selfAcceptance < 0.7) return 'soft-rotate';

  // それ以上はフル回転も視野に入れてよい
  return 'full-rotate';
}

/* =========================================================
   Normal options
========================================================= */

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
        requestedDepth: 'S2' as Depth,
        requestedMode: 'mirror' as IrosMode,
        goalKindHint: 'uncover',
        safetyTag: 'q5_protect',
      },
    },
    {
      id: 'wrap_for_today',
      gear: 'safety',
      label: '今日はここで区切って、また話したくなったら来る',
      description: 'これ以上がんばらず、今日はここでいったん区切る選択肢です。',
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
      label: 'Irosに、いまの状態を短くまとめてもらう',
      description: '自分の状態を短い言葉にして、落ち着きを取り戻すためのモードです。',
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
        requestedDepth: 'R2' as Depth,
        requestedMode: 'mirror' as IrosMode,
        goalKindHint: 'uncover',
        safetyTag: 'none',
      },
    },
    {
      id: 'soft_shift_future',
      gear: 'soft-rotate',
      label: 'この先に進みたい。わからないを解決したい',
      description:
        'I層（未来）の方向に、「進めない理由」と「進めるための成立条件」を短く定義する選択肢です。',
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
      label: '次の一歩（C層）を、短く組み立てる',
      description: '具体的な行動・伝え方・順番を「短い形」にして通します。',
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
      label: '少し先の未来（I層）を、一緒に描いてみる',
      description:
        'まずはI層で、未来の方向性を言葉やイメージにしていきます。',
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
   ✅ IT Demo options
   - C / I / T の固定3ボタン
   - 押したら renderMode='IT' に切り替える材料を meta に入れる
========================================================= */

function buildItDemoOptions(): NextStepOption[] {
  return [
    {
      id: 'it_from_i',
      gear: 'it-demo',
      label: 'I層：未来の方向をそろえる',
      description: '迷いを“構造”として言語化して、未来の軸を先に決める',
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
      id: 'it_from_c',
      gear: 'it-demo',
      label: 'C層：次の一歩を短く出す',
      description: '具体案を1〜2本に絞って、通す形にする（説明は増やさない）',
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
      id: 'it_from_t',
      gear: 'it-demo',
      label: 'T層：核に刺して反転させる',
      description: '意図の核を先に確定して、現実側（C/F）へ流す',
      meta: {
        renderMode: 'IT',
        itTarget: 'T',
        // T は Depth union に無い場合があるので、requestedDepth は I2 に寄せておく（render側でT扱い）
        requestedDepth: 'I2' as Depth,
        requestedMode: 'vision' as IrosMode,
        goalKindHint: 'forward',
        safetyTag: 'none',
      },
    },
  ];
}

/* =========================================================
   Parsing helpers
========================================================= */

/**
 * nextStep ボタン押下のタグを userText から抽出する
 *
 * UIが当面 `[soft_shift_future] xxx` のように送ってくる前提で、
 * - choiceId（= option.id）を取り出す
 * - cleanText（タグを外した本文）も返す
 */
export function extractNextStepChoiceFromText(userText: string): {
  choiceId: string | null;
  cleanText: string;
} {
  const text = String(userText ?? '');

  // 先頭の [id] を拾う（例: "[soft_shift_future] 〜"）
  const m = text.match(/^\s*\[([a-zA-Z0-9_\-]+)\]\s*(.*)$/);
  if (!m) return { choiceId: null, cleanText: text };

  const choiceId = m[1] ?? null;
  const cleanText = (m[2] ?? '').trim();

  return {
    choiceId,
    cleanText: cleanText.length ? cleanText : '',
  };
}

/**
 * option.id から NextStepOption を引く
 * （ギアに依存せず、全候補から探す）
 */
export function findNextStepOptionById(id: string): NextStepOption | null {
  const all = [
    ...buildSafetyOptions(),
    ...buildSoftRotateOptions(),
    ...buildFullRotateOptions(),
    ...buildItDemoOptions(),
  ];
  return all.find((o) => o.id === id) ?? null;
}

/* =========================================================
   Meta attach (offer buttons)
========================================================= */

/**
 * meta に nextStep 情報を付け足すヘルパー
 *
 * ✅ 追加方針：
 * - ITデモが欲しい文言なら「固定3ボタン」を優先で出す
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

  // ✅ ITデモは無効（ボタンを出さない）
  const wantsItDemo = false;

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
