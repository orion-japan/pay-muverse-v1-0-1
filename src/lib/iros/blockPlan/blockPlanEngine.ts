// file: src/lib/iros/blockPlan/blockPlanEngine.ts
//
// iros BlockPlan Engine v2 (自然化 / 例外演出ゲート)
//
// 役割：
// - 「BlockPlan を出す / 出さない」を決めるだけ。
// - 段落の密度・温度・問いの頻度など “体験の質” は Expression Layer 側で制御する。
// - ここは構造（Depth/Q/Phase/slotPlan）を“壊さない”ための安全弁に徹する。
//
// 基本方針：
// - BlockPlan は常用しない（例外演出のみ）。
// - 明示要求（ユーザーが「見出しで」「段で」「ブロックで」等）を最優先。
// - 自動判定は最小（I層以上 + IT_TRIGGER のみ）。それ以外は出さない。
// - 仕様説明（やり方/手順/仕組み/とは）は BlockPlan 禁止（演出で誤魔化さない）。
//
// ✅ 追加（2026-02-26）
// - 相談ゴール（stabilize/repair/counsel）で「言葉の違和感/反発」が出た場合だけ、R帯でも multi6 を許可。
//   目的：リメイク入口（裂け目）を“段構成”で支える。ただし過剰演出はしない（multi6固定 / 条件限定）。
//
// ✅ 重要：
// - 「次の一手 / 最小の一手（NEXT_MIN）」は廃止（BlockPlan では出さない）。
//   ※ “次の一手” は slotPlan(NEXT) の世界で扱う。BlockPlan は段落の整理だけ。

export type BlockKind =
  | 'ENTRY'
  | 'SITUATION'
  | 'DUAL'
  | 'FOCUS_SHIFT'
  | 'ACCEPT'
  | 'INTEGRATE'
  | 'CHOICE';

export type BlockPlanMode = 'multi6' | 'multi7';

export interface BlockPlan {
  mode: BlockPlanMode;
  blocks: BlockKind[];
}

/**
 * ✅ why（運用ログの核）
 * - 「enabled:true/false」だけでは残留・誤判定・自動判定が切れないため、
 *   1ターンで確証を取るための “理由コード” を返す。
 */
export type BlockPlanWhy =
  | 'EXPLICIT'
  | 'AUTO_DEEPEN'
  | 'AUTO_CRACK'
  | 'DIRECT_HARD'
  | 'DIRECT_SOFT'
  | 'NONE';

export interface BlockPlanDiag {
  enabled: boolean;

  // 判定根拠（最小）
  why: BlockPlanWhy;
  explicit: boolean;
  hardDirectTask: boolean;
  softDirectTask: boolean;
  wantsDeeper: boolean;

  // 自動判定の根拠
  depthStage: string | null;
  itTriggered: boolean;
  autoDeepen: boolean;

  goalKind: string | null;
  consultishGoal: boolean;
  autoCrack: boolean;

  // 結果
  mode: BlockPlanMode | null;
  blocksLen: number;
}

export interface BuildBlockPlanParams {
  userText: string;

  // meta（最低限）
  depthStage?: string | null; // 例: 'R3', 'I1', 'T2'
  itTriggered?: boolean | null;

  // 互換（将来拡張用：現状は使わないが署名だけ残す）
  goalKind?: string | null;
  exprLane?: string | null;

  // 明示トリガー（外部から与える場合だけ）
  explicitTrigger?: boolean;
}

/* =========================================================
 * トリガー検出
 * ========================================================= */

/**
 * 明示トリガー：ユーザーが「段取り/構造化/見出し」などを要求した時だけ true。
 * - ここで拾えなければ BlockPlan は入らない（＝見出し直らない）。
 * - “出せるものは出す（後で削る）”方針なので、語彙はやや広めに拾う。
 */
export function detectExplicitBlockPlanTrigger(userText: string): boolean {
  const t = String(userText ?? '').trim();
  if (!t) return false;

  // 日本語 + 軽い英語
  // NOTE: 「見出し」を必ず拾う
  // ✅ 強化：整理/まとめ/アウトライン/テンプレ/型/フレーム等も拾い、explicit を立てやすくする
  // ✅ 明示トリガー語彙を強化し、出過ぎない程度に広げる
  return /(多段|段で|段落で|段取り|ステップ|step|steps|ブロック|レイアウト|構造化|構造で(?:書いて)?|整理して|まとめて|フレーム|枠組み|アウトライン|見出し|セクション|heading|section|テンプレ|型で|章立て|項目で|構成で|段組み|テンプレート)/i.test(
    t,
  );
}

/**
 * directTask（仕様説明/手順/やり方系）：
 * - hard: 絶対禁止（explicitTrigger があっても止める）
 * - soft: 抑制（ただし explicitTrigger=true なら許可）
 *
 * 安定化ルール：
 * - hardDirectTask=true なら必ず BlockPlan なし
 * - explicitTrigger=true なら softDirectTask は無視（= explicit を勝たせる）
 */
function detectDirectTaskHard(userText: string): boolean {
  const t = String(userText ?? '').trim();
  if (!t) return false;

  // 絶対禁止（PDFの核）
  return /(手順書|仕様書|実装|SQL|コード|設計|どうやって|とは|仕組み|手順|やり方|方法)/i.test(t);
}

function detectDirectTaskSoft(userText: string): boolean {
  const t = String(userText ?? '').trim();
  if (!t) return false;

  // ✅ 緩める：ただし「教えて」単体は雑談でも出やすいので除外し、説明依頼寄りだけ拾う
  // ※ hardDirectTask は別で必ず落ちる。ここは “抑制” の軽いフラグ。
  return /(説明して|解説して|紹介して|整理して|まとめて)/i.test(t);
}

/**
 * “深め/長め” ニュアンス：
 * - 明示トリガーがある時に multi7 を選びやすくする。
 */
function detectWantsDeeper(userText: string): boolean {
  const t = String(userText ?? '').trim();
  if (!t) return false;

  return /(詳しく|丁寧に|ちゃんと|しっかり|長め|深め|深掘り|背景|理由|本質)/i.test(t);
}

/**
 * “裂け目（言葉の違和感/反発）” ニュアンス：
 * - R帯でも「リメイク入口」が出た時だけ multi6 を許可するための最小検出。
 * - “説明依頼” は directTask で落ちるので、ここは会話寄りの違和感だけ拾う。
 */
function detectCrackWords(userText: string): boolean {
  const t = String(userText ?? '').trim();
  if (!t) return false;

  return /(不自然|うっとおしい|違和感|ズレ|変だ|なんか違う|合ってない|しっくりこない|やっぱり)/i.test(
    t,
  );
}

/* =========================================================
 * depthStage ユーティリティ（S/F/R/C/I/T + 数字 → rank）
 * ========================================================= */

function depthRank(depthStage?: string | null): number {
  const s = String(depthStage ?? '').trim().toUpperCase();
  if (!s) return 0;

  // 例: S1, F2, R3, C1, I2, T3
  const m = s.match(/^([SFRCIT])\s*([0-9]+)/);
  if (!m) return 0;

  const letter = m[1];
  const n = Math.max(0, Math.min(9, parseInt(m[2], 10) || 0));

  const base =
    letter === 'S'
      ? 10
      : letter === 'F'
        ? 20
        : letter === 'R'
          ? 30
          : letter === 'C'
            ? 40
            : letter === 'I'
              ? 50
              : letter === 'T'
                ? 60
                : 0;

  return base + n;
}

function isDepthAtLeastI1(depthStage?: string | null): boolean {
  // I1 = 51
  return depthRank(depthStage) >= 51;
}

function isDepthAtLeastR1(depthStage?: string | null): boolean {
  // R1 = 31
  return depthRank(depthStage) >= 31;
}

/* =========================================================
 * BlockPlan 生成（ゲート）
 * ========================================================= */

export function buildBlockPlanWithDiag(
  params: BuildBlockPlanParams,
): { plan: BlockPlan | null; diag: BlockPlanDiag } {
  const userText = String(params.userText ?? '').trim();

  // inputs（空でも diag は返す）
  const depthStage = params.depthStage ?? null;
  const itTriggered = typeof params.itTriggered === 'boolean' ? params.itTriggered : false;

  const goalKindNorm = String(params.goalKind ?? '').trim().toLowerCase();
  const goalKind = goalKindNorm ? goalKindNorm : null;

  // autoCrack（相談ゴール + 裂け目）に使うので先に確定
  const consultishGoal =
    goalKind === 'stabilize' || goalKind === 'repair' || goalKind === 'counsel';

  // explicit（外部指定があればそれを優先）
  const explicit =
    typeof params.explicitTrigger === 'boolean'
      ? params.explicitTrigger
      : detectExplicitBlockPlanTrigger(userText);

  // directTask
  const hardDirectTask = userText ? detectDirectTaskHard(userText) : false;
  const softDirectTask = userText ? detectDirectTaskSoft(userText) : false;

  // wantsDeeper（explicit 前提）
  const wantsDeeper = explicit && userText ? detectWantsDeeper(userText) : false;

  // ✅ autoDeepen（強化版）
  // - 従来: I1+ & IT_TRIGGER のみ
  // - 強化: R1+ でも、IT_TRIGGER が来ていて「相談ゴール」 or 「深め語彙」があるなら許可
  const autoDeepen =
    (isDepthAtLeastI1(depthStage) && Boolean(itTriggered)) ||
    (isDepthAtLeastR1(depthStage) &&
      Boolean(itTriggered) &&
      (consultishGoal || (userText ? detectWantsDeeper(userText) : false)));

  // autoCrack（相談ゴール + 裂け目）
  const autoCrack = consultishGoal && userText ? detectCrackWords(userText) : false;

  // =========================================================
  // gate decision
  // =========================================================

  // 1) userText が空 → NONE
  if (!userText) {
    return {
      plan: null,
      diag: {
        enabled: false,
        why: 'NONE',
        explicit: false,
        hardDirectTask: false,
        softDirectTask: false,
        wantsDeeper: false,

        depthStage,
        itTriggered,
        autoDeepen: false,

        goalKind,
        consultishGoal,
        autoCrack: false,

        mode: null,
        blocksLen: 0,
      },
    };
  }

  // 2) hardDirectTask は常に禁止（explicit でも止める）
  if (hardDirectTask) {
    return {
      plan: null,
      diag: {
        enabled: false,
        why: 'DIRECT_HARD',
        explicit,
        hardDirectTask: true,
        softDirectTask,
        wantsDeeper,

        depthStage,
        itTriggered,
        autoDeepen,

        goalKind,
        consultishGoal,
        autoCrack,

        mode: null,
        blocksLen: 0,
      },
    };
  }

  // 3) softDirectTask は “抑制” だが、autoDeepen/autoCrack が立っているなら通す
  //    （= 明示が無くても出る方向に寄せる。ただし hardDirectTask は別で必ず落ちる）
  if (!explicit && softDirectTask && !autoDeepen && !autoCrack) {
    return {
      plan: null,
      diag: {
        enabled: false,
        why: 'DIRECT_SOFT',
        explicit: false,
        hardDirectTask: false,
        softDirectTask: true,
        wantsDeeper: false,

        depthStage,
        itTriggered,
        autoDeepen,

        goalKind,
        consultishGoal,
        autoCrack,

        mode: null,
        blocksLen: 0,
      },
    };
  }

  // 4) explicit/autoDeepen/autoCrack どれも無い → NONE
  if (!explicit && !autoDeepen && !autoCrack) {
    return {
      plan: null,
      diag: {
        enabled: false,
        why: 'NONE',
        explicit: false,
        hardDirectTask: false,
        softDirectTask,
        wantsDeeper: false,

        depthStage,
        itTriggered,
        autoDeepen,

        goalKind,
        consultishGoal,
        autoCrack,

        mode: null,
        blocksLen: 0,
      },
    };
  }

  // 5) explicit → multi7 or multi6
  if (explicit) {
    if (wantsDeeper) {
      const plan: BlockPlan = {
        mode: 'multi7',
        blocks: ['ENTRY', 'SITUATION', 'DUAL', 'FOCUS_SHIFT', 'ACCEPT', 'INTEGRATE', 'CHOICE'],
      };
      return {
        plan,
        diag: {
          enabled: true,
          why: 'EXPLICIT',
          explicit: true,
          hardDirectTask: false,
          softDirectTask,
          wantsDeeper: true,

          depthStage,
          itTriggered,
          autoDeepen,

          goalKind,
          consultishGoal,
          autoCrack,

          mode: plan.mode,
          blocksLen: plan.blocks.length,
        },
      };
    }

    const plan: BlockPlan = {
      mode: 'multi6',
      blocks: ['ENTRY', 'SITUATION', 'DUAL', 'FOCUS_SHIFT', 'ACCEPT', 'INTEGRATE'],
    };
    return {
      plan,
      diag: {
        enabled: true,
        why: 'EXPLICIT',
        explicit: true,
        hardDirectTask: false,
        softDirectTask,
        wantsDeeper: false,

        depthStage,
        itTriggered,
        autoDeepen,

        goalKind,
        consultishGoal,
        autoCrack,

        mode: plan.mode,
        blocksLen: plan.blocks.length,
      },
    };
  }

  // 6) autoDeepen / autoCrack → multi6
  const plan: BlockPlan = {
    mode: 'multi6',
    blocks: ['ENTRY', 'SITUATION', 'DUAL', 'FOCUS_SHIFT', 'ACCEPT', 'INTEGRATE'],
  };

  const why: BlockPlanWhy = autoDeepen ? 'AUTO_DEEPEN' : 'AUTO_CRACK';

  return {
    plan,
    diag: {
      enabled: true,
      why,
      explicit: false,
      hardDirectTask: false,
      softDirectTask,
      wantsDeeper: false,

      depthStage,
      itTriggered,
      autoDeepen,

      goalKind,
      consultishGoal,
      autoCrack,

      mode: plan.mode,
      blocksLen: plan.blocks.length,
    },
  };
}

// 既存互換：従来の buildBlockPlan API は温存（呼び出し側を壊さない）
export function buildBlockPlan(params: BuildBlockPlanParams): BlockPlan | null {
  return buildBlockPlanWithDiag(params).plan;
}

/* =========================================================
 * system4（例外演出用）: 短い契約
 * ========================================================= */

/**
 * renderBlockPlanSystem4
 * - system 注入専用（ユーザーに見せない）
 * - “段取り” だけを与え、内容や構造の推定・上書きを禁止する
 *
 * 見出しについて：
 * - UI の見出し化事故を避けるため、見出しは「## 見出し」だけ許可に寄せる。
 * - sanitize 側で # は落ちるので、ユーザー表示では「見出し文字」だけ残る（狙い通り）。
 *
 * 質問について：
 * - たまにならOK。毎回は不要。必要な時だけ 0〜1。
 */
export function renderBlockPlanSystem4(plan: BlockPlan): string {
  const requiredOrder = plan.blocks.join(' -> ');
  const mode = plan.mode;

  // multi6 / multi7 は「常時 見出し付き」を強制
  const forceHeads = mode === 'multi6' || mode === 'multi7';

  const heads6 = [
    '今ここを揃える',
    'いま見ているもの',
    '二つの見方',
    '焦点を一つだけ移す',
    'いったん受け止める',
    '一枚に戻す',
  ];
  const heads = mode === 'multi7' ? [...heads6, 'ここで一つ選ぶ'] : heads6;

  const emojis = heads.map((_h, i) => {
    if (i === 0) return '🌀';
    if (i === 1) return '🔍';
    if (i === 2) return '↔️';
    if (i === 3) return '🎯';
    if (i === 4) return '🪷';
    if (i === 5) return '🧩';
    return '✅';
  });

  const headRules = forceHeads
    ? [
        `【${mode} 見出しルール（強制）】`,
        `- ${mode} の場合、各ブロックは必ず Markdown 見出しで区切る（必須・例外なし）。`,
        `- 見出し行は必ず「## 」で始める（2つの # + 半角スペース）。`,
        `- 見出しの文言は固定。言い換え・短縮・並び替え禁止。順番も固定。`,
        `- 見出しは必ず「## 絵文字1つ + 半角スペース + 見出し本文」。`,
        `- 見出し以外の本文では、ENTRY/SITUATION/DUAL/FOCUS_SHIFT/ACCEPT/INTEGRATE/CHOICE などラベル名は一切出さない。`,
        ``,
        `【固定見出し（この順番・この文言のまま）】`,
        ...heads.map((h, i) => `- ${i + 1}) ## ${emojis[i]} ${h}`),
        ``,
        `【自己検査（必須）】`,
        `- 返信の先頭が「## 」で始まっていない場合は失敗。本文を書き直してから出力する。`,
        `- 見出しが ${heads.length} 個そろっていない場合も失敗。書き直す。`,
        ``,
      ].join('\n')
    : '';

  return [
    '【内部指示】以下はシステム制約。返信本文に一切含めない。引用/要約/言い換えもしない。',
    '',
    '【BLOCK_PLAN（DO NOT OUTPUT）】',
    '- これは “段取り” だけ。内容・結論・構造メタ（depth/q/phase/flow 等）を新規に推定したり上書きしない。',
    '- 本文は自然文。見出し以外ではラベル名（ENTRY 等）を出さない。',
    '',
    `- mode: ${mode}`,
    `- requiredOrder: ${requiredOrder}`,
    headRules
      ? headRules
      : '- 見出しを使う場合のみ、形式は「## 絵文字1つ + 半角スペース + 見出し本文」にする。',
    '- 質問は必要なときだけ 0〜1（毎回は不要）。',
  ]
    .filter(Boolean)
    .join('\n');
}
