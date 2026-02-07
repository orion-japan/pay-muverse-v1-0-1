// src/lib/iros/intentTransition/intentBridge.ts
// iros — Intent Bridge (R→I explicit / I→T reconfirm + Lane decision)
//
// 目的：
// - 「意図入口」を明示化する（R→I）
// - 「今回の会話でTを使ってよい」を再同期する（I→T）
// - 返信の“目的レーン”を確定して返す（IDEA_BAND / T_CONCRETIZE）
// - 既存のIT/transitionEngine/Policyの決定を置換しない（補助のみ）
//
// 制約：
// - LLMは使わない
// - depthStage を勝手に上げない
// - itx_step のアップグレードはしない（T3固定の再確認のみ）
// - itx_reason は原則上書きしない（既存の決定を尊重）
//
// ログ：
// - 1行だけ。userTextは出さない（個人情報/冗長回避）
// - DEBUG_INTENT_BRIDGE=1 のときだけ出す

export type IntentBand = 'I';

// レーンは“常に確定して返す”前提（下流の迷いを消す）
export type LaneKey =
  | 'IDEA_BAND' // R→I 候補生成（核なし）
  | 'T_CONCRETIZE'; // I→C→T 具体化（核あり/宣言あり）

export type IntentBridgeResult = {
  // ✅ レーン確定（必ず入る）
  laneKey: LaneKey;

  // “Iに入った”を明示する補助
  intentBand?: IntentBand;
  intentEntered?: true;

  // “今回もTを使ってよい”を再同期する補助（既存のIT決定は置換しない）
  itReconfirmed?: true;

  // 互換のために返せるが、適用側で「原則上書きしない」こと
  itxStep?: 'T3';
  itxReason?: 'IT_RECONFIRMED_IN_CONVERSATION';
};

export function applyIntentBridge(args: {
  depthStage: string | null;
  phase: string | null;
  deepenOk?: boolean; // 渡せない場合があるので optional
  fixedNorthKey?: string | null; // 例: 'SUN'
  userText: string;

  // ✅ レーン判定の入力（渡せない場合もあるので optional）
  // 方針：未提供なら false 扱い（保守的に IDEA_BAND）
  hasCore?: boolean;
  declarationOk?: boolean;
}): IntentBridgeResult {
  const depth = safeStr(args.depthStage);
  const phase = safeStr(args.phase);
  const deepenOk = args.deepenOk === true; // 渡せない/不明なら false（保守）
  const fixedNorthKey = safeStr(args.fixedNorthKey);
  const text = normalizeJapanese(args.userText);

  const hasCore = args.hasCore === true;
  const declarationOk = args.declarationOk === true;

  // --- 0) Lane decision（最重要：常に確定して返す）
  const laneKey = decideLaneKey({ hasCore, declarationOk });

  // --- 1) R→I（入口の明示）
  // 方針：誤爆を避ける（保守的）
  // deepenOk が取れない環境でも最低限動かすが、deepenOk=false のときは発火を絞る
  const hasIntentLexeme = reIntentLexeme(text);
  const inReasonableBand =
    // v1: 深度を厳密に見ない（"C1でも内省文が来る"ケースがあるため）
    // ただし空なら false にしない（空でも通す）
    depth.length === 0 ? true : /^[SRCI T]/.test(depth) || /^[A-Z]\d+$/.test(depth);

  const enterI =
    inReasonableBand &&
    hasIntentLexeme &&
    // deepenOk が true の時は入りやすく、false の時は “宣言系” のみで入る
    (deepenOk ? true : reIntentLexemeStrong(text));

  // --- 2) I→T（再同期）
  // “固定アンカーがSUNで、かつ今回の会話で方針宣言がある”時のみ
  // ※ IT_ALREADY_COMMITTED など既存判定は置換しない。あくまで「今回も使ってよい」のフラグ。
  const reconfirmT =
    enterI &&
    fixedNorthKey === 'SUN' &&
    rePolicyReconfirm(text);

  // ✅ out は laneKey を必ず持つ（下流の迷い消し）
  const out: IntentBridgeResult = { laneKey };

  if (enterI) {
    out.intentBand = 'I';
    out.intentEntered = true;
  }
  if (reconfirmT) {
    out.itReconfirmed = true;
    out.itxStep = 'T3';
    out.itxReason = 'IT_RECONFIRMED_IN_CONVERSATION';
  }

  if (shouldDebug()) {
    // userTextは出さない
    console.log('[IROS/IntentBridge]', {
      laneKey,
      enterI,
      reconfirmT,
      deepenOk,
      hasCore,
      declarationOk,
      depth: depth || null,
      phase: phase || null,
      fixedNorthKey: fixedNorthKey || null,
    });
  }

  return out;
}

/* -----------------------------
   lane
----------------------------- */

export function decideLaneKey(params: {
  hasCore: boolean;
  declarationOk: boolean;
}): LaneKey {
  // ✅ 暫定：非Tユーザーでは T_CONCRETIZE に落とさない
  // - 現状は hasCore/declarationOk が広すぎて、ほぼ常に T_CONCRETIZE が発火してしまう。
  // - REMAKE レーン導入までは、通常会話は IDEA_BAND に固定して “かもしれません連発” の圧を下げる。
  return 'IDEA_BAND';
}


/* -----------------------------
   helpers
----------------------------- */

function safeStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function normalizeJapanese(s: string): string {
  return (s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * “意図入口”の弱い表現（広め）
 * - したくない/避けたい/繰り返したくない/迷う など
 */
function reIntentLexeme(text: string): boolean {
  return /したくない|避けたい|繰り返したくない|同じことを繰り返したくない|迷(う|っている)|分からない|わからない/.test(
    text
  );
}

/**
 * deepenOk が取れない/false の時にだけ使う “強め” パターン
 * - 誤爆防止のため、より宣言・再発防止に寄せる
 */
function reIntentLexemeStrong(text: string): boolean {
  return /同じことを繰り返したくない|繰り返したくない|今回は.*(しない|避ける|やめる)|失敗.*(したくない|避けたい)/.test(
    text
  );
}

/**
 * “方針の再確認”パターン（I→Tの再同期用）
 * - 決めている/勢いでは動かない/納得できる一歩/小さくても など
 */
function rePolicyReconfirm(text: string): boolean {
  return /決めて(い|る)|勢いでは動かない|納得できる一歩|小さくても|同じことを繰り返したくない/.test(
    text
  );
}

function shouldDebug(): boolean {
  // ランタイムによって process が無い可能性があるので安全に
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = (globalThis as any)?.process?.env;
    return String(env?.DEBUG_INTENT_BRIDGE ?? '') === '1';
  } catch {
    return false;
  }
}
