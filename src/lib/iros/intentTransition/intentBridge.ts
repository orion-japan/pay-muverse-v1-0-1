// src/lib/iros/intentTransition/intentBridge.ts
// iros — Intent Bridge (R→I explicit / I→T reconfirm + Lane decision)

export type IntentBand = 'I';

export type LaneKey =
  | 'IDEA_BAND'
  | 'T_CONCRETIZE';

export type IntentBridgeResult = {
  laneKey: LaneKey;
  intentBand?: IntentBand;
  intentEntered?: true;
  itReconfirmed?: true;
  focusLabel?: string;
  itxStep?: 'T3';
  itxReason?: 'IT_RECONFIRMED_IN_CONVERSATION';
};

export function applyIntentBridge(args: {
  depthStage: string | null;
  phase: string | null;
  deepenOk?: boolean;
  fixedNorthKey?: string | null;
  userText: string;
  lastAssistantText?: string;
  hasCore?: boolean;
  declarationOk?: boolean;
}): IntentBridgeResult {

  const text = normalizeJapanese(args.userText);
  const hasCore = args.hasCore === true;
  const declarationOk = args.declarationOk === true;

  // ------------------------------------------------
  // 1️⃣ Lane基本決定（候補要求だけIDEA_BAND）
  // ------------------------------------------------
  const laneKeyBase: LaneKey = decideLaneKey({
    userText: text,
    hasCore,
    declarationOk,
  });

  // ------------------------------------------------
  // 2️⃣ 選択検出（最重要）
  // ------------------------------------------------
  const focusLabelRaw = pickFocusLabelFromSelection({
    userText: text,
    lastAssistantText: safeStr(args.lastAssistantText),
  });

  const focusLabel = typeof focusLabelRaw === 'string' ? focusLabelRaw.trim() : '';
  const hasFocus = focusLabel.length > 0;

  const out: IntentBridgeResult = {
    laneKey: hasFocus ? 'T_CONCRETIZE' : laneKeyBase,
  };

  if (hasFocus) {
    out.focusLabel = focusLabel;
  }

  if (shouldDebug()) {
    console.log('[IROS/IntentBridge]', {
      laneKey: out.laneKey,
      hasFocus,
    });
  }


  return out;
}

/* -----------------------------
   Lane decision
----------------------------- */

export function decideLaneKey(args: {
  userText: string;
  hasCore: boolean;
  declarationOk: boolean;
}): LaneKey {
  const t = normalizeJapanese(args.userText);

  // ✅ ここだけIDEA_BAND（=候補列挙契約を当てたい要求）
  // 「候補を4つ」「選択肢」「どれがいい？」「案を出して」「一行ずつ」など
  const wantsCandidates =
    /(候補|選択肢|オプション|案を|案が|並べて|一覧|リスト|一行ずつ|1行ずつ|どれ|どっち|どちら|どの|何を(優先|先|すべき)|優先するべき|おすすめ)/.test(
      t,
    ) ||
    /([2-9])\s*(?:つ|個|案)/.test(t);

  if (wantsCandidates) return 'IDEA_BAND';

  // ✅ それ以外は T_CONCRETIZE に倒す（IDEA_BAND契約の誤爆を避ける）
  // hasCore / declarationOk が立ってるならなおさら T へ寄せる
  if (args.hasCore || args.declarationOk) return 'T_CONCRETIZE';

  return 'T_CONCRETIZE';
}

/* -----------------------------
   selection detection
----------------------------- */

function pickFocusLabelFromSelection(args: {
  userText: string;
  lastAssistantText: string;
}): string | undefined {

  const t = normalizeJapanese(args.userText);
  if (!t) return undefined;

  const isThat =
    t === 'それ' || t === 'これ' || t === 'あれ' || t === 'そこ' || t === 'ここ';

  const hasChooseVerb =
    /(にする|にします|にしよう|にしよ|でいく|で行く|でいきます|決めた|決めます|採用|これで|それで|それにする|それがいい)/.test(
      t,
    );

  const num = extractSelectionNumber(t);

  const candidates = parseCandidatesFromAssistant(args.lastAssistantText);

  if (candidates.length === 0) {
    if (typeof num === 'number' && hasChooseVerb) return `選択:${num}`;
    if ((isThat || hasChooseVerb) && t.length <= 16) return '選択:指差し';
    return undefined;
  }

  if (typeof num === 'number') {
    const idx = Math.max(0, Math.min(candidates.length - 1, num - 1));
    const picked = candidates[idx];
    if (picked) return clamp(picked, 80);
    return `選択:${num}`;
  }

  if (isThat || hasChooseVerb) {
    const picked = candidates[candidates.length - 1];
    if (picked) return clamp(picked, 80);
    return '選択:指差し';
  }

  return undefined;
}

/* -----------------------------
   number extraction
----------------------------- */

function extractSelectionNumber(t: string): number | undefined {

  const circled: Record<string, number> = {
    '①': 1, '②': 2, '③': 3, '④': 4, '⑤': 5,
    '⑥': 6, '⑦': 7, '⑧': 8, '⑨': 9,
  };
  if (t in circled) return circled[t];

  const z2h: Record<string, string> = {
    '１':'1','２':'2','３':'3','４':'4','５':'5',
    '６':'6','７':'7','８':'8','９':'9',
  };

  const tt = t.replace(/[１２３４５６７８９]/g, m => z2h[m] ?? m);

  const m1 = tt.match(/([1-9])\s*(?:つ目|番目|番|つ)/);
  if (m1) return Number(m1[1]);

  if (/^[1-9]$/.test(tt)) return Number(tt);

  const m2 = tt.match(/([1-9])/);
  if (m2 && tt.length <= 16) return Number(m2[1]);

  return undefined;
}

/* -----------------------------
   candidate parse
----------------------------- */

function parseCandidatesFromAssistant(lastAssistantText: string): string[] {

  const raw = normalizeJapanese(lastAssistantText);
  if (!raw) return [];

  const lines = raw
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean);

  const stripIndex = (s: string) =>
    s.replace(/^\s*\d+\s*(?:[.)。：:、,])\s*/u, '').trim();

  const cand = lines
    .map(stripIndex)
    .filter(x => x.length > 0 && x.length <= 120);

  if (cand.length < 2) return [];

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
  return t.length <= max ? t : t.slice(0, max);
}

function normalizeJapanese(s: string): string {
  return (s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function shouldDebug(): boolean {
  try {
    const env = (globalThis as any)?.process?.env;
    return String(env?.DEBUG_INTENT_BRIDGE ?? '') === '1';
  } catch {
    return false;
  }
}
