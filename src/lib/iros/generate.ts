// src/lib/iros/generate.ts
// iros — Writer: 1ターン返信生成コア（芯=coreIntent 強制 / 回転メタ注入）
//
// 互換方針：
// - 呼び出し側が seed/chatCore/handleIrosReply で揺れていても型で落ちないようにする
// - 返り値は content を正とし、text/assistantText など旧互換も同値で返す
// - ✅ LLM へ会話履歴（history）を渡し、会話の流れを LLM が保持できるようにする
//
// 追加方針（2025-12-17）:
// - 短文（超短い入力）には「芯」「回転」「制約」を文章に乗せない
// - ただし “数値メタ” だけは必ず末尾に 1 行で付ける（説明は禁止）

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat';

import { getSystemPrompt, type IrosMeta, type IrosMode } from './system';
import {
  decideQBrakeRelease,
  normalizeQ,
} from '@/lib/iros/rotation/qBrakeRelease';
import { runItDemoGate } from '@/lib/iros/rotation/itDemoGate';

/** ✅ 旧/新ルートを全部受ける（型で落ちない） */
export type GenerateArgs = {
  /** 旧: text */
  text?: string;
  /** 新: userText */
  userText?: string;

  /** ✅ chatCore が undefined を渡すため optional */
  meta?: IrosMeta;

  /** ✅ seed/future-seed が渡している */
  conversationId?: string;
  history?: unknown[];

  /** その他が来ても落とさない */
  [k: string]: any;
};

/** ✅ 旧/新参照を全部返す（型で落ちない） */
export type GenerateResult = {
  content: string;

  // 旧互換
  text: string;

  // ✅ ここを “必須” + IrosMode に戻す（chatCore がこれを要求してる）
  mode: IrosMode;

  intent?: any;

  // 新系互換（残してOK）
  assistantText?: string;
  metaForSave?: any;
  finalMode?: string | null;
  result?: any;

  [k: string]: any;
};

const IROS_MODEL =
  process.env.IROS_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o';

/* =========================================================
   CORE INTENT
   ========================================================= */

function pickCoreIntent(meta: any): string | null {
  const fromAnchor =
    meta?.intent_anchor?.text &&
    typeof meta.intent_anchor.text === 'string' &&
    meta.intent_anchor.text.trim().length > 0
      ? meta.intent_anchor.text.trim()
      : null;

  const fromCoreNeed =
    meta?.intentLine?.coreNeed &&
    typeof meta.intentLine.coreNeed === 'string' &&
    meta.intentLine.coreNeed.trim().length > 0
      ? meta.intentLine.coreNeed.trim()
      : null;

  const fromUnified =
    meta?.unified?.intent_anchor?.text &&
    typeof meta.unified.intent_anchor.text === 'string' &&
    meta.unified.intent_anchor.text.trim().length > 0
      ? meta.unified.intent_anchor.text.trim()
      : null;

  const isThinQuestion = (s: string) => {
    const t = s.replace(/\s+/g, '');
    if (t.length <= 10) return true;
    if (
      /^(何が出来ますか|何ができますか|どうすればいい|どうしたらいい|どうすれば)$/.test(
        t,
      )
    )
      return true;
    return false;
  };

  const candidate = fromAnchor ?? fromCoreNeed ?? fromUnified ?? null;
  if (!candidate) return null;
  if (isThinQuestion(candidate)) return null;

  return candidate;
}

/* =========================================================
   SHORT INPUT DETECTOR
   ========================================================= */

function normalizeUserText(s: string): string {
  return String(s ?? '').trim();
}

/**
 * “短文” 判定：
 * - かなり短い入力は、文章に「芯/回転/制約」を乗せない
 * - ただし数値メタだけは末尾に付ける
 */
function isShortTurn(userText: string): boolean {
  const t = normalizeUserText(userText)
    .replace(/[！!。．…]+$/g, '')
    .trim();
  if (!t) return false;

  // 目安：10文字以下（記号だけ/1文字は除外）
  const core = t.replace(/[?？]/g, '').replace(/\s+/g, '');
  if (core.length < 2) return true;
  return core.length <= 10;
}

/* =========================================================
   RENDER MODE (IT / NORMAL)
   - buildWriterProtocol / buildWriterHintsFromMeta で共通化
   ========================================================= */

// src/lib/iros/generate.ts
// ✅ renderMode の単一ソースは「meta.extra.renderMode / meta.renderMode」
// （どっちに立ってても IT を拾えるようにする）
function getRenderMode(meta: any): 'IT' | 'NORMAL' {
  const rmRaw =
    (meta as any)?.extra?.renderMode ??
    (meta as any)?.extra?.render_mode ??
    (meta as any)?.renderMode ??
    (meta as any)?.render_mode ??
    '';

  const rm = String(rmRaw).trim().toUpperCase();
  return rm === 'IT' ? 'IT' : 'NORMAL';
}


/* =========================================================
   NUMERIC FOOTER (numbers only)
   ========================================================= */

function toNum(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function toIntLike(v: unknown): number | null {
  const n = toNum(v);
  if (n === null) return null;
  return Math.round(n);
}

function fmt(v: number | null, digits = 2): string | null {
  if (v === null) return null;
  const d = Math.max(0, Math.min(6, digits));
  return v.toFixed(d);
}

/**
 * 末尾に付ける「数値だけ」行（説明禁止）
 * - 例：〔sa0.52 y2 h1 pol0.09 g0.52 t0.20 p0.50〕
 * - 無い値は出さない（空になったら null）
 */
function buildNumericFooter(meta: any): string | null {
  const sa =
    toNum(meta?.selfAcceptance) ??
    toNum(meta?.unified?.selfAcceptance) ??
    toNum(meta?.unified?.self_acceptance) ??
    null;

  const y =
    toIntLike(meta?.yLevel) ??
    toIntLike(meta?.unified?.yLevel) ??
    toIntLike(meta?.unified?.y_level) ??
    null;

  const h =
    toIntLike(meta?.hLevel) ??
    toIntLike(meta?.unified?.hLevel) ??
    toIntLike(meta?.unified?.h_level) ??
    null;

  const pol =
    toNum(meta?.unified?.polarityScore) ?? toNum(meta?.polarityScore) ?? null;

  // renderEngine の vector で計算されてることが多い想定だが、無いなら出さない
  const g = toNum(meta?.unified?.grounding) ?? toNum(meta?.grounding) ?? null;
  const t =
    toNum(meta?.unified?.transcendence) ?? toNum(meta?.transcendence) ?? null;
  const p = toNum(meta?.unified?.precision) ?? toNum(meta?.precision) ?? null;

  const parts: string[] = [];

  const saS = fmt(sa, 2);
  if (saS) parts.push(`sa${saS}`);

  if (y !== null) parts.push(`y${y}`);
  if (h !== null) parts.push(`h${h}`);

  const polS = fmt(pol, 2);
  if (polS) parts.push(`pol${polS}`);

  const gS = fmt(g, 2);
  if (gS) parts.push(`g${gS}`);

  const tS = fmt(t, 2);
  if (tS) parts.push(`t${tS}`);

  const pS = fmt(p, 2);
  if (pS) parts.push(`p${pS}`);

  if (!parts.length) return null;

  return `〔${parts.join(' ')}〕`;
}

/* =========================================================
   SAFE SLOT → GENERATION CONTROL
   ========================================================= */

/**
 * meta.slotPlan から SAFE タグを拾う
 * - slotBuilder は { OBS, SHIFT, NEXT, SAFE } の object を入れている想定
 * - truthy なら発火（本文には一切出さない）
 */
function pickSafeTagFromMeta(meta: any): string | null {
  const sp = meta?.slotPlan;
  if (!sp || typeof sp !== 'object') return null;

  const safe = (sp as any).SAFE;
  if (typeof safe === 'string' && safe.trim().length > 0) return safe.trim();

  // 念のため：SAFE が boolean / その他でも truthy なら拾う
  if (!!safe) return String(safe);

  return null;
}

/**
 * SAFE 制御メッセージ（system）
 * - “警告文”を出すのではなく、LLMの生成姿勢を制動する
 * - SAFE / gate / meta 等の語は本文に出させない
 */
function buildSafeSystemMessage(
  meta: any,
  userText: string,
): ChatCompletionMessageParam | null {
  const safeTag = pickSafeTagFromMeta(meta);
  if (!safeTag) return null;

  // 強度（offered は “減速”、accepted は “守り” を強める）
  const isOffered = safeTag.includes('offered');
  const isAccepted = safeTag.includes('accepted');

  const lines: string[] = [];

  lines.push('【SAFE_CONTROL】');
  lines.push('このターンは安全制動が必要です。');
  lines.push('');
  lines.push('絶対条件：');
  lines.push(
    '- 本文に「SAFE」「安全」「ゲート」「メタ」「プロトコル」「スロット」等の内部語を出さない',
  );
  lines.push(
    '- 強い断定・決めつけ・診断っぽい言い回しを避ける（特に心身・医療・法律・金融）',
  );
  lines.push('- 危険行為/医療判断/法的判断/投資判断の具体助言はしない');
  lines.push(
    '- ユーザーの主権を保持：命令形の連発、詰問、圧の強い誘導は禁止',
  );
  lines.push('- 文章は短く（最大3〜5行）。必要なら改行して静かに。');
  lines.push('- 質問は0〜1（原則0）。問いが必要なら最後に1つだけ、短く。');

  if (isOffered) {
    lines.push('');
    lines.push('制動の方針（offered）：');
    lines.push('- “整える/保留する/一旦置く” の方向へ寄せる');
    lines.push('- 次の一歩は「小さく」「戻れる」形で1つだけ');
  }

  if (isAccepted) {
    lines.push('');
    lines.push('制動の方針（accepted）：');
    lines.push('- “守る/固定する/安全に着地させる” を優先する');
    lines.push('- 次の一歩は「いま守れる最小ルール」を1つだけ');
  }

  // 念のため userText を参照（LLMに “いま何を返すか” を誤解させない）
  lines.push('');
  lines.push(`USER_TEXT: ${String(userText)}`);

  return { role: 'system', content: lines.join('\n') };
}

/* =========================================================
   WRITER PROTOCOL (full rewrite)
   - Always attach / Conditional apply: WHISPER
   - Short / IT / Normal
   - No “template smell” while still deterministic
========================================================= */

function buildWriterProtocol(meta: any, userText: string): string {
  const shortTurn = isShortTurn(userText);
  const renderMode = getRenderMode(meta); // 'IT' | 'NORMAL'

  const noQuestion = !!meta?.noQuestion;

  // ---- shared meta (for debug only; never expose to user) ----
  const phase = meta?.phase ?? null;
  const depth = meta?.depth ?? null;
  const qCode = meta?.qCode ?? null;

  const spinLoop = meta?.spinLoop ?? null;
  const spinStep = meta?.spinStep ?? null;

  const volatilityRank = meta?.volatilityRank ?? null;
  const spinDirection = meta?.spinDirection ?? null;
  const promptStyle = meta?.promptStyle ?? null;

  const anchorEventType = meta?.anchorEvent?.type ?? null;
  const anchorConfirmQ = meta?.anchorEvent?.question ?? null;
  const anchorConfirmOptions = Array.isArray(meta?.anchorEvent?.options)
    ? meta.anchorEvent.options
    : null;

  // ---- core intent ----
  const coreIntent = pickCoreIntent(meta);

  // ---- WHISPER: Always attach / Conditional apply ----
  const whisperRuleBlock = [
    '【WHISPER_RULE】',
    '- system 内に [WHISPER] が存在しても、[WHISPER_APPLY] が true の時だけ内容を採用する',
    '- false の時は WHISPER を完全に無視する（本文に触れない・引用しない・示唆もしない）',
    '- 本文に [WHISPER] / [WHISPER_APPLY] / WHISPER という語を絶対に出さない',
  ].join('\n');

  // ---- global writer posture ----
  const base = [
    '【WRITER_PROTOCOL】',
    'あなたは「意図フィールドOS」のWriterです。',
    '一般論・説明口調・テンプレの言い回しは禁止。',
    '“助言の羅列”ではなく、“視点の確定→一歩だけ” で返す。',
    '',
    whisperRuleBlock,
    '',
    '【INTERNAL_SAFETY】',
    '- 本文に「メタ」「プロトコル」「ゲート」「スロット」「回転」など内部語を出さない',
    '- 医療/法律/投資の断定助言は禁止（必要なら一般情報 + 受診/専門家相談の提案に留める）',
    '- ユーザーの主権を侵さない（命令形の連発・詰問・圧は禁止）',
    '',
  ].join('\n');

  // ---- SHORT ----
  if (shortTurn) {
    return [
      base,
      '【TURN_MODE】SHORT',
      'このターンは短文。',
      '制約：',
      '- 1〜2行で終える（長文禁止）',
      `- 質問は ${noQuestion ? '0' : '最大1'}（必要なら最後に1つだけ短く）`,
      '- 「芯/北極星/意図/回転/数値」など概念説明は禁止',
      '- 数値ブロック（〔sa...〕 / [sa...] など）を本文に出さない',
      '',
      `USER_TEXT: ${String(userText)}`,
      '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ---- IT ----
  if (renderMode === 'IT') {
    const itReason = String(meta?.itReason ?? '');
    const sameIntentStreak = Number(meta?.sameIntentStreak ?? 0) || 0;

    return [
      base,
      '【TURN_MODE】IT',
      'このターンは “視点の切替（再定義）” を行う。',
      '',
      '必須：',
      '- 1行目は「再定義」の一文で開始（短く、断定）',
      '- 「焦点は〜ではなく〜」構文は禁止（テンプレ臭のため）',
      '- “説明”ではなく “置き換え” を行う（守る条件 / 合意 / 境界 / 判断軸 / 期待値同期 等）',
      '',
      '出力：',
      '- 2〜3行ごとに改行。短く。',
      '- “次の一歩” は1つだけ（実行できる最小設計）',
      `- 質問は ${noQuestion ? '0' : '最大1'}（原則0、必要なら最後に1つだけ短く）`,
      '',
      '禁止：',
      '- ありがちな一般論（「落ち着いて」「信頼できる人に」等）',
      '- ToDo羅列が続く箇条書き',
      '- 相手を断罪/診断する言い方',
      '- “機能説明” を本文に出す（IT/反復/ゲート等の内部語も禁止）',
      '',
      `IT_HINT: reason=${itReason} sameIntentStreak=${String(sameIntentStreak)}`,
      '',
      `USER_TEXT: ${String(userText)}`,
      '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ---- NORMAL (non-IT) ----

  // A) coreIntent missing → “北極星を1行で確定” して一歩
  if (!coreIntent) {
    return [
      base,
      '【TURN_MODE】NORMAL',
      'CORE_INTENT は未確定。',
      '',
      'やることは2つだけ：',
      '- 1行目で「いま守りたい一点（北極星）」を “会話として自然な日本語” で確定する',
      '- 2〜3行目以降で “次の一歩” を1つだけ置く（小さく、戻れる形）',
      '',
      '制約：',
      '- 固定の見出し（例：北極星／いま置ける一歩／確認…）を毎回必ず出すのは禁止',
      `- 質問は ${noQuestion ? '0' : '最大1'}（詰問禁止。必要なら最後に短く）`,
      '- 断定は強めでよい（「〜してみるといい」より「〜を置く」）',
      '- 一般論/説教/説明口調は禁止',
      '',
      `OBS_META: phase=${String(phase)} depth=${String(depth)} q=${String(
        qCode,
      )} spinLoop=${String(spinLoop)} spinStep=${String(
        spinStep,
      )} rank=${String(volatilityRank)} direction=${String(
        spinDirection,
      )} promptStyle=${String(promptStyle)}`,
      '',
      `USER_TEXT: ${String(userText)}`,
      '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // B) coreIntent present → “言い換え断定 → 一歩”
  const anchorConfirmBlock =
    anchorEventType === 'confirm' && typeof anchorConfirmQ === 'string'
      ? [
          '【ANCHOR_CONFIRM】',
          '揺らぎが高い：最優先でアンカー確認を出す。',
          `確認質問: ${anchorConfirmQ}`,
          anchorConfirmOptions ? `選択肢: ${anchorConfirmOptions.join(' / ')}` : '',
          '※確認の後に “次の一歩” を1つだけ添える。',
        ]
          .filter(Boolean)
          .join('\n')
      : '';

  return [
    base,
    '【TURN_MODE】NORMAL',
    'CORE_INTENT は確定。',
    '',
    `CORE_INTENT: 「${coreIntent}」`,
    '',
    '必須：',
    '- 返答の1行目で CORE_INTENT を “言い換えて” 断定する（同文コピペ禁止）',
    '- 2〜3行ごとに改行。短く。',
    '- “次の一歩” は1つだけ（promptStyle=two-choice の時だけ2択まで）',
    `- 質問は ${noQuestion ? '0' : '最大1'}（必要なら最後に1つだけ短く）`,
    '',
    anchorConfirmBlock ? anchorConfirmBlock : '',
    '',
    '禁止：',
    '- 「まず落ち着いて」等の一般的な慰め',
    '- 機能説明だけで終わる',
    '- ユーザーに丸投げ（“選んでみて” の連発）',
    '',
    `ROTATION_META: spinLoop=${String(spinLoop)} spinStep=${String(
      spinStep,
    )} phase=${String(phase)} depth=${String(depth)} q=${String(qCode)} rank=${String(
      volatilityRank,
    )} direction=${String(spinDirection)} promptStyle=${String(promptStyle)}`,
    '',
    `USER_TEXT: ${String(userText)}`,
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

/* =========================================================
   HISTORY → MESSAGES（会話履歴を LLM に渡す）
   ========================================================= */

/**
 * ✅ history を ChatCompletionMessageParam[] に正規化
 * - どんな shape が混ざっても落ちない
 * - system は混ぜない（汚染防止）
 * - 直近 maxItems だけ送る（トークン暴発防止）
 */
function normalizeHistoryToMessages(
  history: unknown,
  maxItems = 12,
): ChatCompletionMessageParam[] {
  const src = Array.isArray(history) ? history : [];
  const out: ChatCompletionMessageParam[] = [];

  const pickRole = (v: any): 'user' | 'assistant' | null => {
    const r = v?.role ?? v?.sender ?? v?.from ?? v?.type ?? null;

    // system は絶対に混ぜない
    if (r === 'system') return null;

    if (r === 'user' || r === 'human') return 'user';
    if (r === 'assistant' || r === 'ai' || r === 'bot') return 'assistant';

    return null;
  };

  const pickText = (v: any): string | null => {
    if (typeof v === 'string') return v;
    if (!v) return null;

    // よくあるキーを広めに救う
    const c =
      (typeof v.content === 'string' && v.content) ||
      (typeof v.text === 'string' && v.text) ||
      (typeof v.message === 'string' && v.message) ||
      (typeof v.body === 'string' && v.body) ||
      (typeof v.value === 'string' && v.value) ||
      null;

    if (c) return c;

    // 最低限救う（unknown が混ざっても会話が死なない）
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);

    return null;
  };

  // 後ろから maxItems 件だけ採る
  const tail = src.slice(Math.max(0, src.length - maxItems));

  for (const item of tail) {
    const role = pickRole(item);
    const text = pickText(item);

    if (!role || !text) continue;

    out.push({ role, content: text });
  }

  return out;
}

/**
 * ✅ 末尾の「今回入力と同一の user 発話」を重複排除（保険）
 */
function dedupeTailUser(
  historyMessages: ChatCompletionMessageParam[],
  userText: string,
): ChatCompletionMessageParam[] {
  if (historyMessages.length === 0) return historyMessages;

  const last = historyMessages[historyMessages.length - 1];
  if (last.role !== 'user') return historyMessages;

  const lastText = String((last as any).content ?? '').trim();
  if (!lastText) return historyMessages;

  if (lastText === String(userText ?? '').trim()) {
    return historyMessages.slice(0, -1);
  }
  return historyMessages;
}

// ==============================
// Frame / Slots hint (Writer)
// - meta.framePlan を最優先で拾い、meta.frame と同期する版（debug logs込み）
// ==============================

type FrameKind = 'S' | 'R' | 'C' | 'I' | 'T' | 'MICRO' | 'NONE';

function normalizeFrameKind(v: unknown): FrameKind | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (
    s === 'S' ||
    s === 'R' ||
    s === 'C' ||
    s === 'I' ||
    s === 'T' ||
    s === 'MICRO' ||
    s === 'NONE'
  ) {
    return s as FrameKind;
  }
  return null;
}

function buildWriterHintsFromMeta(meta: any): {
  frame: FrameKind | null;
  slotKeys: string[];
  hintText: string | null;
} {
  const fp =
    meta?.framePlan && typeof meta.framePlan === 'object' ? meta.framePlan : null;

  // ✅ renderMode は getRenderMode(meta) だけを見る（単一ソース）
  //    ※ extra / 直下どちらに立っても IT を拾える
  const rm = getRenderMode(meta); // 'IT' | 'NORMAL'

  // ✅ whisper の採用条件は IT のみ（precision/stuck は排除）
  const whisperApply = rm === 'IT';


  // --- debug: 入口で見えている meta/framePlan を固定観測 ---
  console.log('[IROS/frame-debug] input', {
    meta_frame_before: meta?.frame ?? null,
    framePlan_frame: fp?.frame ?? null,
    framePlan_slots_keys: Array.isArray(fp?.slots)
      ? fp.slots.map((s: any) => s?.key).filter(Boolean)
      : null,
    slotPlan_keys:
      meta?.slotPlan && typeof meta.slotPlan === 'object'
        ? Object.keys(meta.slotPlan)
        : null,
  });

  // ① frame: framePlan.frame を“唯一の正”として採用
  const frameFromPlan = normalizeFrameKind(fp?.frame);
  const frameFromMeta = normalizeFrameKind(meta?.frame);

  const frame: FrameKind | null = frameFromPlan ?? frameFromMeta ?? null;

  // ✅ frame は「この関数内のローカル決定」だけで扱う（meta は汚さない）
  console.log('[IROS/frame-debug] decided', {
    frameFromPlan: frameFromPlan ?? null,
    meta_frame_before: meta?.frame ?? null,
    decided_frame: frame,
  });

  // ② slots: framePlan.slots → meta.slotPlan の順で拾う
  const slotKeysFromPlan: string[] = Array.isArray(fp?.slots)
    ? fp.slots
        .map((s: any) => (typeof s?.key === 'string' ? s.key : null))
        .filter(Boolean)
    : [];

  const slotPlan: Record<string, any> =
    meta?.slotPlan && typeof meta.slotPlan === 'object' ? meta.slotPlan : {};

  const slotKeysFromMap = Object.entries(slotPlan)
    .filter(([, v]) => !!v)
    .map(([k]) => k);

  const slotKeys =
    slotKeysFromPlan.length > 0 ? slotKeysFromPlan : slotKeysFromMap;

  if (!frame && slotKeys.length === 0) {
    return { frame: null, slotKeys: [], hintText: null };
  }

  const frameGuide: Record<FrameKind, string> = {
    S: '自己の内側（観測→整える）を短く深く',
    R: '状況/相手/関係（接続→見取り図）を中心に',
    C: '具体の実行案（手順/次の一歩）を中心に',
    I: '意図/軸（なぜ/何のため）を中心に',
    T: 'ひらめき/視点上昇（俯瞰→再定義）を中心に',
    MICRO: '超短文でも崩れない最小返答（1〜3行）',
    NONE: '装飾少なめ、素の返答でOK',
  };

  const hintLines: string[] = [];
  if (frame) hintLines.push(`FRAME=${frame}（${frameGuide[frame]}）`);
  if (slotKeys.length > 0) hintLines.push(`SLOTS=${slotKeys.join(',')}`);

  const hintText =
    `【writer hint】\n` +
    hintLines.join('\n') +
    `\n- これはテンプレ本文ではなく、返答の型/観点のヒントです。\n` +
    `- スロットは全て埋めなくてOK。自然な日本語を最優先。`;

  return { frame, slotKeys, hintText };
}

// ===== history から Q を拾うユーティリティ =====
// src/lib/iros/generate.ts

function pickRecentUserQsFromHistory(history: any[], take = 3): string[] {
  const out: string[] = [];
  const hs = Array.isArray(history) ? history : [];

  // newest last を作りたいので「古い→新しい」で走査
  for (let i = 0; i < hs.length; i++) {
    const m = hs[i];
    if (!m) continue;

    const role = String(m.role ?? '').toLowerCase();
    if (role !== 'user') continue;

    // ✅ ここが重要：HistoryX / turnHistory / 旧互換のどれでも拾えるようにする
    const qRaw =
      (m.q_code ?? null) ??
      (m.q ?? null) ??
      (m.qCode ?? null) ??
      (m.meta?.qCode ?? null) ??
      (m.meta?.q_code ?? null) ??
      (m.meta?.q ?? null);

    const q = normalizeQ(qRaw); // generate.ts 冒頭で import されている normalizeQ を使う
    if (!q) continue;

    out.push(q);

    // 直近だけ残す（サイズ管理）
    if (out.length > take) out.splice(0, out.length - take);
  }

  return out;
}

/* =========================================================
   MAIN
   ========================================================= */

/** ✅ 既存呼び出しが generateIrosReply を使っている前提でこの名前に揃える */
export async function generateIrosReply(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const meta: IrosMeta = (args.meta ?? ({} as IrosMeta)) as IrosMeta;
  const userText = String((args as any).text ?? (args as any).userText ?? '');

  // =========================================================
  // MemoryState attach (generate side)
  // - cooldown 判定が必ず効くように、args.memoryState を meta に取り込む
  // =========================================================
  const memoryStateFromArgs = (args as any)?.memoryState ?? null;
  if (
    memoryStateFromArgs &&
    typeof memoryStateFromArgs === 'object' &&
    !(meta as any)?.memoryState
  ) {
    (meta as any).memoryState = memoryStateFromArgs;
  }

  // ついでに q_counts 直下も補助的に載せる（参照揺れ対策）
  if (
    !(meta as any)?.q_counts &&
    (meta as any)?.memoryState?.q_counts &&
    typeof (meta as any).memoryState.q_counts === 'object'
  ) {
    (meta as any).q_counts = (meta as any).memoryState.q_counts;
  }



  // ==============================
  // Frame sticky を断つ（重要）
  // - args.meta は毎回 frame を含み得る（前ターン残骸）
  // - generate では毎ターン必ず一回クリアして、framePlan で決める
  // ==============================
  if (meta && typeof meta === 'object') {
    delete (meta as any).frame;
    delete (meta as any).slots;
    delete (meta as any).frameSlots;
  }

  /* ---------------------------------
     QTrace / QNow / recentUserQs
     ※ すべて let。再宣言しない
  --------------------------------- */

  let qTrace: any = (meta as any)?.qTrace ?? null;

  let qNow: string | null = normalizeQ(
    (meta as any)?.qPrimary ?? (meta as any)?.q_code ?? qTrace?.lastQ ?? null,
  );

  let recentUserQs: string[] = [];

  /* ---------------------------------
     history から拾う
  --------------------------------- */
  recentUserQs = pickRecentUserQsFromHistory((args as any).history, 3);

  /* ---------------------------------
     qTrace を必ず合成（反復を作る）
  --------------------------------- */
  const streakQ = normalizeQ(qTrace?.streakQ ?? qTrace?.lastQ ?? null);

  if (streakQ) {
    if (recentUserQs.length === 0) {
      recentUserQs = [streakQ];
    } else if (recentUserQs[recentUserQs.length - 1] === streakQ) {
      recentUserQs = [...recentUserQs, streakQ];
    }
    recentUserQs = recentUserQs.slice(-3);
  }

  /* ---------------------------------
     Qブレーキ判定
  --------------------------------- */
  const qBrake = decideQBrakeRelease({
    qNow,
    sa: (meta as any)?.selfAcceptance ?? null,
    recentUserQs,
  });

  /* ---------------------------------
     適用
  --------------------------------- */
  if (qBrake.shouldRelease) {
    (meta as any).intentLayer = 'I';
    (meta as any).extra = (meta as any).extra ?? {};
    (meta as any).extra.generalBrake = 'OFF';
    (meta as any).extra.brakeReleaseReason = qBrake.reason;
    (meta as any).extra.brakeReleaseDetail = qBrake.detail;

    console.log('[IROS][QBrakeRelease][generate] ON', {
      qNow,
      reason: qBrake.reason,
      detail: qBrake.detail,
      recentUserQs,
    });
  } else {
    console.log('[IROS][QBrakeRelease][generate] OFF', {
      qNow,
      reason: qBrake.reason,
      detail: qBrake.detail,
      recentUserQs,
    });
  }


/* ---------------------------------
   IT DEMO TRIGGER + COOLDOWN（確実版 / 交互仕様）
--------------------------------- */

const userCodeForLog = String((args as any)?.userCode ?? '');

// ✅ generate.ts では meta 経由のみ使う（memoryState は未定義）
const qCounts =
  (((meta as any)?.memoryState?.qCounts ??
    (meta as any)?.memoryState?.q_counts ??
    (meta as any)?.q_counts ??
    (meta as any)?.rotationState?.q_counts ??
    {}) as Record<string, any>);

const itCooldownPrev = Number(qCounts?.it_cooldown ?? 0);

// qBrake.detail から Q2×2 を確定
const qBrakeDetail = (qBrake as any)?.detail ?? {};
const isQ2x2 =
  qNow === 'Q2' &&
  (qBrakeDetail.q2_streak2 === true ||
   qBrakeDetail.qNow_streak2 === true);

// ✅ 交互仕様：前回1ならブロック、0なら許可
const itAllowed = itCooldownPrev <= 0;

const IT_REASON = 'Q2x2(by qBrake.detail)';

if (isQ2x2 && itAllowed) {
  (meta as any).extra = (meta as any).extra ?? {};

  (meta as any).renderMode = 'IT';
  (meta as any).extra.renderMode = 'IT';
  (meta as any).extra.forceIT = true;

  (meta as any).itReason = IT_REASON;
  (meta as any).extra.itReason = IT_REASON;

  console.log('[IROS][ITDemo][generate] ON', {
    userCode: userCodeForLog,
    qNow,
    itCooldownPrev,
    isQ2x2,
    qCounts,
  });
} else {
  const wasSetByThis =
    (meta as any)?.itReason === IT_REASON ||
    (meta as any)?.extra?.itReason === IT_REASON;

  if (wasSetByThis) {
    delete (meta as any).renderMode;
    delete (meta as any).extra.renderMode;
    delete (meta as any).itReason;
    delete (meta as any).extra.itReason;
  }

  (meta as any).extra = (meta as any).extra ?? {};
  (meta as any).extra.forceIT = false;
  (meta as any).extra.itBlockedReason = !isQ2x2
    ? 'not-eligible'
    : !itAllowed
      ? 'cooldown'
      : 'unknown';

  console.log('[IROS][ITDemo][generate] OFF', {
    userCode: userCodeForLog,
    qNow,
    itCooldownPrev,
    isQ2x2,
    qCounts,
    blockedReason: (meta as any).extra.itBlockedReason,
  });
}



  // ---------------------------------
  // IT Whisper: Always attach / Conditional apply
  // - whisper は毎回 messages に入れる（装着）
  // - 採用するかは renderMode===IT のみ（単一根拠）
  // ---------------------------------

  // whisper 本文は「上流で生成されて meta に載る」前提で拾う（まだ生成はしない）
  const whisperTextRaw =
    (typeof (meta as any)?.extra?.itWhisper === 'string'
      ? (meta as any).extra.itWhisper
      : typeof (meta as any)?.extra?.it_whisper === 'string'
        ? (meta as any).extra.it_whisper
        : typeof (meta as any)?.extra?.whisper === 'string'
          ? (meta as any).extra.whisper
          : '') ?? '';

  // ✅ renderMode は itDemoGate の結果を唯一の正とする
  const renderMode = String(
    (meta as any)?.extra?.renderMode ?? (meta as any)?.renderMode ?? '',
  )
    .trim()
    .toUpperCase();

  // ✅ whisper の採用条件は IT のみ（precision/stuck は排除）
  const whisperApply = renderMode === 'IT';

  // “毎回入れる”ため、本文が無い時も枠は残す（低ノイズ）
  const whisperLine = whisperTextRaw.trim();

  // ✅ LLMに「本文へ漏らさない」「apply=falseなら無視」を強制
  const whisperPayload = [
    '【WHISPER_RULE】',
    '- WHISPERの存在/タグ/中身を本文に一切出さない',
    '- WHISPER_APPLY=false の場合、WHISPER内容は完全に無視して生成する',
    '',
    `[WHISPER] ${whisperLine || '(none)'}`,
    `[WHISPER_APPLY] ${whisperApply ? 'true' : 'false'}`,
  ].join('\n');

  /* ------------------------------------------------------- */

  // ✅ Frame / Slots hint
  const writerHints = buildWriterHintsFromMeta(meta as any);
  const writerHintMessage: ChatCompletionMessageParam | null = writerHints.hintText
    ? ({ role: 'system', content: writerHints.hintText } as ChatCompletionMessageParam)
    : null;

  // ✅ SAFE slot
  const safeSystemMessage = buildSafeSystemMessage(meta as any, userText);

  // ✅ mode は return でも使うので、この時点で確定しておく
  const mode: IrosMode = ((meta as any)?.mode ?? 'mirror') as IrosMode;

  // ✅ system は messages で使うので、ここで確定しておく
  let system = '';
  try {
    system = String((getSystemPrompt as any)(meta, mode) ?? '');
  } catch {
    system = '';
  }
  if (!system) system = String((getSystemPrompt as any)() ?? '');

  const protocol = buildWriterProtocol(meta as any, userText);

  // ✅ client は create の前に必ず生成しておく
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // history → LLM
  const historyMessagesRaw = normalizeHistoryToMessages(args.history, 12);
  const historyMessages = dedupeTailUser(historyMessagesRaw, userText);

  const pastStateNoteText =
    typeof (meta as any)?.extra?.pastStateNoteText === 'string'
      ? (meta as any).extra.pastStateNoteText.trim()
      : '';

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    { role: 'system', content: protocol },

    // ✅ WHISPER は毎回 attach（apply は WHISPER_APPLY のみで制御）
    { role: 'system', content: whisperPayload },

    ...(safeSystemMessage ? [safeSystemMessage] : []),
    ...(writerHintMessage ? [writerHintMessage] : []),
    ...(pastStateNoteText
      ? ([{ role: 'system', content: pastStateNoteText }] as ChatCompletionMessageParam[])
      : []),

    ...historyMessages,
    { role: 'user', content: userText },
  ];

  const res = await client.chat.completions.create({
    model: IROS_MODEL,
    messages,
    temperature: 0.7,
  });

  let content =
    res.choices?.[0]?.message?.content?.trim() ?? '……（応答生成に失敗しました）';

  /* ---------------------------------
     Numeric footer
  --------------------------------- */

  const showNumericFooter =
    process.env.IROS_NUMERIC_FOOTER === '1' ||
    (meta as any)?.extra?.showNumericFooter === true;

  const hardHideNumericFooter =
    (meta as any)?.microOnly === true ||
    (meta as any)?.recallOnly === true ||
    String(mode) === 'recall';

  if (showNumericFooter && !hardHideNumericFooter) {
    content = content.replace(/\n*\s*[〔\[]sa[^\n]*[〕\]]\s*$/g, '').trim();

    const footer = buildNumericFooter(meta as any);
    if (footer) {
      content = `${content}\n${footer}`;
    }
  }

  /* ---------------------------------
     return
  --------------------------------- */
  return {
    content,
    text: content,
    mode,
    intent: (meta as any)?.intent ?? (meta as any)?.intentLine ?? null,
    assistantText: content,
    metaForSave: meta ?? {},
    finalMode: String(mode),
    result: null,
  };
}
