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
  return /(多段|段で|段落で|ブロック|レイアウト|構造で(?:書いて)?|深めて|深掘り|見出し|セクション|heading|section)/i.test(
    t,
  );
}

/**
 * directTask（仕様説明/手順/やり方系）：
 * - ここで BlockPlan を出すと “説明依頼” が演出で歪むので禁止。
 * - ただし過検出すると窮屈になるので、語彙は最小〜中くらいに。
 */
function detectDirectTask(userText: string): boolean {
  const t = String(userText ?? '').trim();
  if (!t) return false;

  // 「とは/仕組み/手順/やり方/方法/実装/どうやって」など
  // ※「教えて」は雑談でも入るので単体では拾わない
  return /(仕組み|手順|やり方|方法|実装|設計|仕様|どうやって|とは)/i.test(t);
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

/* =========================================================
 * BlockPlan 生成（ゲート）
 * ========================================================= */

export function buildBlockPlan(params: BuildBlockPlanParams): BlockPlan | null {
  const userText = String(params.userText ?? '').trim();
  if (!userText) return null;

  const depthStage = params.depthStage ?? null;
  const itTriggered = typeof params.itTriggered === 'boolean' ? params.itTriggered : false;

  // 1) 説明依頼は BlockPlan 禁止（演出で誤魔化さない）
  if (detectDirectTask(userText)) return null;

  // 2) 明示トリガー（ユーザー指定）を最優先
  const explicit =
    typeof params.explicitTrigger === 'boolean'
      ? params.explicitTrigger
      : detectExplicitBlockPlanTrigger(userText);

  // 3) 自動トリガー（最小）
  // - I層以上が確定していて、かつ IT_TRIGGER が立っている時だけ許可
  const autoDeepen = isDepthAtLeastI1(depthStage) && Boolean(itTriggered);

  // 4) どちらも無いなら絶対に出さない
  if (!explicit && !autoDeepen) return null;

  // ---------------------------------------------
  // 明示指定：
  // - wantsDeeper=true なら multi7（CHOICE まで入れて段を少し増やす）
  // - wantsDeeper=false なら multi6（軽量）
  //
  // 自動判定：
  // - 過剰演出を避けるため multi6 固定
  // ---------------------------------------------
  if (explicit) {
    const wantsDeeper = detectWantsDeeper(userText);

    if (wantsDeeper) {
      return {
        mode: 'multi7',
        blocks: ['ENTRY', 'SITUATION', 'DUAL', 'FOCUS_SHIFT', 'ACCEPT', 'INTEGRATE', 'CHOICE'],
      };
    }

    return {
      mode: 'multi6',
      blocks: ['ENTRY', 'SITUATION', 'DUAL', 'FOCUS_SHIFT', 'ACCEPT', 'INTEGRATE'],
    };
  }

  // autoDeepen（I層以上 + IT_TRIGGER） → multi6（軽め）
  return {
    mode: 'multi6',
    blocks: ['ENTRY', 'SITUATION', 'DUAL', 'FOCUS_SHIFT', 'ACCEPT', 'INTEGRATE'],
  };
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

  return [
    '【内部指示】以下はシステム制約。返信本文に一切含めない。引用/要約/言い換えもしない。',
    '',
    `mode: ${plan.mode}`,
    `order: ${requiredOrder}`,
    '',
    '目的：例外的に「段取り」だけ与える。Depth/Q/Phase/slotPlan は絶対に変えない。',
    '禁止：Depth/Q/Phase/slotPlan の変更・推定・上書き、診断ラベルの露出。',
    '',
    '出力ルール：',
    '- 見出しは「## 見出し」形式のみ（### や記号だらけの装飾は禁止）。',
    '- 内部ブロック名（ENTRY/SITUATION/DUAL/FOCUS_SHIFT/ACCEPT/INTEGRATE/CHOICE）や「二項/焦点移動/受容」等の語を本文に出さない。',
    '- 境界は空行で表現。箇条書き・番号・チェックリストで埋めない。',
    '- 一般論で薄めず、各段落にユーザー文の具体語を最低1つ入れる。',
    '- 質問は 0〜1。毎回は付けない（必要な時だけ末尾に添える）。',
    '',
    '密度：',
    '- 1段落は 2〜4文までOK（ただし1段落が長文化しすぎないよう改行で分ける）。',
    '- multi6：全体で 6〜12 段落（完走優先）',
    '- multi7：全体で 8〜16 段落（完走優先）',
    '',
    '重要：',
    '- 「次の一手 / 最小の一手 / NEXT_MIN」系の段落は作らない（BlockPlanの責務外）。',
  ].join('\n').trim();
}
