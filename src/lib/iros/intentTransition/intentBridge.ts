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

  // ✅ 選択が起きたときの「一点」（T_CONCRETIZE の focus）
  // - “それ” / “4つ目” / “2番” などで確定
  focusLabel?: string;

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

  // ✅ 直前assistant本文（候補列挙→選択の確定に使う）
  lastAssistantText?: string;

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
  // NOTE: ここは「通常の lane」。ただし “選択確定” が起きたら下で上書きして T_CONCRETIZE にする
  const laneKeyBase = decideLaneKey({ hasCore, declarationOk });

  // --- A) “選択”検出（それ/番号/OK）
  const focusLabel = pickFocusLabelFromSelection({
    userText: text,
    lastAssistantText: safeStr(args.lastAssistantText),
  });

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
  // - “選択確定” が起きたら T_CONCRETIZE に倒す（深度は触らない）
  const out: IntentBridgeResult = {
    laneKey: focusLabel ? 'T_CONCRETIZE' : laneKeyBase,
    ...(focusLabel ? { focusLabel } : {}),
  };

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
      laneKey: out.laneKey,
      enterI,
      reconfirmT,
      deepenOk,
      hasCore,
      declarationOk,
      depth: depth || null,
      phase: phase || null,
      fixedNorthKey: fixedNorthKey || null,
      // ✅ 選択だけログ（本文は出さない）
      hasFocus: Boolean(focusLabel),
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
   selection → focusLabel
----------------------------- */

function pickFocusLabelFromSelection(args: {
  userText: string;
  lastAssistantText: string;
}): string | undefined {
  const tRaw = String(args.userText ?? '');
  const t = normalizeJapanese(tRaw);
  if (!t) return undefined;

  // “それ/これ/あれ” 系（単体 or 末尾に !/！ が付く程度まで）
  const isThat =
    t === 'それ' || t === 'これ' || t === 'あれ' || t === 'そこ' || t === 'ここ';

  // 選択・採用の動詞（「にする」「でいく」「決めた」など）
  const hasChooseVerb =
    /(にする|にします|でいく|で行く|でいきます|決めた|決めます|採用|これで|それで|それにする|それがいい)/.test(
      t,
    );

  // “n番目/ nつ目 / n番 / ④ / 4” を拾う（1〜9程度）
  const num = extractSelectionNumber(t);

  const candidates = parseCandidatesFromAssistant(args.lastAssistantText);

  // ✅ 重要：候補が取れなくても「選択が起きた」事実は拾う
  // - 番号＋選択動詞 がある場合は強いので、focusLabel を仮ラベルで確定する
  // - “それ/OK” 系も同様に拾う（仮ラベル）
  if (candidates.length === 0) {
    if (typeof num === 'number' && hasChooseVerb) return `選択:${num}`;
    if ((isThat || hasChooseVerb) && t.length <= 12) return '選択:指差し';
    return undefined;
  }

  // 候補がある場合：番号は範囲外なら最後に丸める（現場のサルベージ崩れ対策）
  if (typeof num === 'number') {
    const idx = Math.max(0, Math.min(candidates.length - 1, num - 1));
    const picked = candidates[idx];
    if (typeof picked === 'string' && picked.trim()) return clamp(picked.trim(), 80);
    return `選択:${num}`;
  }

  // “それ/OK” は「最後＝spotlight」を採用（既存仕様）
  if (isThat || hasChooseVerb) {
    const picked = candidates[candidates.length - 1];
    if (typeof picked === 'string' && picked.trim()) return clamp(picked.trim(), 80);
    return '選択:指差し';
  }

  return undefined;
}

function extractSelectionNumber(t: string): number | undefined {
  // ①②③④⑤⑥⑦⑧⑨
  const circled: Record<string, number> = {
    '①': 1, '②': 2, '③': 3, '④': 4, '⑤': 5,
    '⑥': 6, '⑦': 7, '⑧': 8, '⑨': 9,
  };
  if (t in circled) return circled[t];

  // “4つ目 / 4番目 / 4番 / 4つ”
  const m1 = t.match(/([1-9])\s*(?:つ目|番目|番|つ)\b/);
  if (m1) return Number(m1[1]);

  // “4” 単体（短文だけ）
  if (/^[1-9]$/.test(t)) return Number(t);

  // “4つ目がいい” みたいな文
  const m2 = t.match(/\b([1-9])\b/);
  if (m2 && t.length <= 12) return Number(m2[1]);

  return undefined;
}

function parseCandidatesFromAssistant(lastAssistantText: string): string[] {
  const raw = String(lastAssistantText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!raw) return [];

  const lines = raw
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

  // “1) ” / “1.” / “1:” / “1、” / “1：”
  const stripIndex = (s: string) =>
    s
      .replace(/^\s*\d+\s*(?:[.)。：:、,])\s*/u, '')
      .replace(/^\s*(?:[・•●\-\*\u2013\u2014])\s+/u, '')
      .trim();

  // 候補っぽい行だけ残す（安全側）
  const cand = lines
    .map(stripIndex)
    .map((x) => x.replace(/[🔥✨🌱🌀🪔🌸]+/g, '').trim())
    .filter(Boolean)
    .filter((x) => x.length <= 120);

  // 2行未満は候補とみなさない（誤爆防止）
  if (cand.length < 2) return [];

  // 最大9まで
  return cand.slice(0, 9);
}

/* -----------------------------
   helpers
----------------------------- */

function safeStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function clamp(s: string, max: number): string {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  return t.slice(0, max);
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
    text,
  );
}

/**
 * deepenOk が取れない/false の時にだけ使う “強め” パターン
 * - 誤爆防止のため、より宣言・再発防止に寄せる
 */
function reIntentLexemeStrong(text: string): boolean {
  return /同じことを繰り返したくない|繰り返したくない|今回は.*(しない|避ける|やめる)|失敗.*(したくない|避けたい)/.test(
    text,
  );
}

/**
 * “方針の再確認”パターン（I→Tの再同期用）
 * - 決めている/勢いでは動かない/納得できる一歩/小さくても など
 */
function rePolicyReconfirm(text: string): boolean {
  return /決めて(い|る)|勢いでは動かない|納得できる一歩|小さくても|同じことを繰り返したくない/.test(
    text,
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
