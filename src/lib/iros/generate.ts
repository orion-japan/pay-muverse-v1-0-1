// src/lib/iros/generate.ts
// iros — Writer: 1ターン返信生成コア（v2 / empty-body防止 / SpeechAct単一ソース / ITはtLayerModeActive単一）
//
// ✅ v2の最重要要件（今回の「content/text/assistantText が空」事故を潰す）
// - 生成経路がどう揺れても「本文は必ず非空」で返す（… でもいいが "" は禁止）
// - render-v2 は入力が空だと何も作れない → generate側で non-empty を保証
// - SpeechAct は applySpeechAct の結果を単一ソースにする（allowLLM含む）
// - IT判定は renderMode を見ない。meta.tLayerModeActive / tLayerHint のみ
// - history は system汚染なしで渡す。末尾重複は除去
//
// NOTE:
// - OpenAI直叩きは禁止。chatComplete（単一出口）を使う。
// - 「コードは1つずつ提示」方針に従い、このファイル全文のみ提示

import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';

import { getSystemPrompt, SofiaTriggers } from '../iros/system';
import { decideQBrakeRelease, normalizeQ } from '@/lib/iros/rotation/qBrakeRelease';
import { naturalClose } from '../iros/phrasing';
import type { IntentMeta as IrosMeta } from './intentMeta';
import type { IrosMode } from './memory/mode';

// ✅ SpeechAct
import { decideSpeechAct } from './speech/decideSpeechAct';
import { applySpeechAct } from './speech/applySpeechAct';
import { enforceAllowSchema } from './speech/enforceAllowSchema';
import type { DecideSpeechActInput } from './speech/decideSpeechAct';
import type { SpeechDecision } from './speech/types';

/** ✅ 旧/新ルートを全部受ける（型で落ちない） */
export type GenerateArgs = {
  /** 旧: text */
  text?: string;
  /** 新: userText */
  userText?: string;

  /**
   * ✅ chatCore/route が “欠けたmeta” を渡してくるので Partial を許容する
   * - future-seed/seed などで layer/confidence/reason が無いことがある
   */
  meta?: Partial<IrosMeta> | null;

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

  // ✅ 必須: chatCore がこれを要求してる
  mode: IrosMode;

  intent?: any;

  // 新系互換（残してOK）
  assistantText?: string;
  metaForSave?: any;
  finalMode?: string | null;
  result?: any;

  // ✅ SpeechAct debug
  speechAct?: string;
  speechReason?: string;

  [k: string]: any;
};

const IROS_MODEL = process.env.IROS_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o';

/* =========================================================
   Helpers (non-empty guarantee)
   ========================================================= */

function normalizeUserText(s: string): string {
  return String(s ?? '').trim();
}

function normalizeOne(v: unknown): string {
  return String(v ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeText(v: unknown): string {
  return normalizeOne(v).replace(/[ \t]+/g, ' ').trim();
}

function firstNonEmptyLine(s: string): string | null {
  const lines = normalizeOne(s)
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  return lines[0] ?? null;
}

/** ✅ どんな経路でも "" は返さない（最低でも "…"） */
function ensureNonEmpty(s: unknown, fallback = '…'): string {
  const t = normalizeText(s);
  return t.length ? t : fallback;
}

/** v2: NORMAL の最低限fallback（空返し事故用） */
function fallbackNormalBody(userText: string, meta: any): string {
  const t = normalizeText(userText);
  const phase = String(meta?.phase ?? '').toLowerCase();
  const q = String(meta?.qCode ?? meta?.q ?? meta?.q_code ?? '').toUpperCase();

  if (t.length <= 2) return '一点だけ決めて、増やさない。';
  if (q === 'Q1') return '不足がどれくらいかを確認し、動かせる点を一つに絞る。';
  if (phase === 'inner') return 'いま起きている一点を名指しして、迷いを終える。';
  return '状況を一度整理し、調整できる部分を一つに絞る。';
}

/* =========================================================
   meta normalizer (Partial -> IntentMeta)
   ========================================================= */

function normalizeIntentMeta(m?: Partial<IrosMeta> | null): IrosMeta {
  const base: any = m && typeof m === 'object' && !Array.isArray(m) ? { ...m } : {};
  // ✅ 欠損しがちな必須キーを埋める（route側が IrosMeta でも落ちない）
  if (!('layer' in base)) base.layer = null;
  if (!('confidence' in base)) base.confidence = null;
  if (!('reason' in base)) base.reason = null;
  return base as IrosMeta;
}

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

  const fromSituationSummary =
    typeof meta?.situationSummary === 'string' && meta.situationSummary.trim()
      ? meta.situationSummary.trim()
      : typeof meta?.unified?.situationSummary === 'string' && meta.unified.situationSummary.trim()
        ? meta.unified.situationSummary.trim()
        : typeof meta?.unified?.situation_summary === 'string' && meta.unified.situation_summary.trim()
          ? meta.unified.situation_summary.trim()
          : null;

  const isThinQuestion = (s: string) => {
    const t = s.replace(/\s+/g, '');
    if (t.length <= 10) return true;
    if (/^(何が出来ますか|何ができますか|どうすればいい|どうしたらいい|どうすれば)$/.test(t)) return true;
    return false;
  };

  const candidate = fromAnchor ?? fromCoreNeed ?? fromUnified ?? fromSituationSummary ?? null;
  if (!candidate) return null;
  if (isThinQuestion(candidate)) return null;
  return candidate;
}

/* =========================================================
   SHORT INPUT DETECTOR
   ========================================================= */

   function isShortTurn(userText: string): boolean {
    // “SHORT” は micro/挨拶/単発リアクション級だけに寄せる
    // - 10文字は日本語では通常会話になりやすいので広すぎた
    const t = normalizeUserText(userText).replace(/[！!。．…]+$/g, '').trim();
    if (!t) return false;

    // 記号・スペース・末尾? は無視して “実質” だけを見る
    const core = t.replace(/[?？]/g, '').replace(/\s+/g, '');

    // 1文字以下は短文扱い（ノイズ/単語）
    if (core.length < 2) return true;

    // ✅ ここが本命：SHORT を “超短文” に限定
    // - micro（<=8）と役割が被らないよう、さらに狭くする
    return core.length <= 6;
  }


/* =========================================================
   T-LAYER (IT) ACTIVE DETECTOR (single source)
   ========================================================= */

function isTLayerActive(meta: any): boolean {
  const on = meta?.tLayerModeActive === true;

  const hint = String(meta?.tLayerHint ?? '').trim().toUpperCase();
  const hintOk = hint === 'T1' || hint === 'T2' || hint === 'T3';

  return on || hintOk;
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

  const pol = toNum(meta?.unified?.polarityScore) ?? toNum(meta?.polarityScore) ?? null;

  const g = toNum(meta?.unified?.grounding) ?? toNum(meta?.grounding) ?? null;
  const t = toNum(meta?.unified?.transcendence) ?? toNum(meta?.transcendence) ?? null;
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

function pickSafeTagFromMeta(meta: any): string | null {
  const sp = meta?.slotPlan;
  if (!sp) return null;

  if (typeof sp === 'object' && !Array.isArray(sp)) {
    const direct = (sp as any).SAFE;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
  }

  const slots = (sp as any)?.slots;
  if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
    const safe = (slots as any).SAFE;
    if (typeof safe === 'string' && safe.trim()) return safe.trim();
    if (!!safe) return String(safe);
  }

  return null;
}

function buildSafeSystemMessage(meta: any, userText: string): ChatMessage | null {
  const safeTag = pickSafeTagFromMeta(meta);
  if (!safeTag) return null;

  const isOffered = safeTag.includes('offered');
  const isAccepted = safeTag.includes('accepted');

  const lines: string[] = [];

  lines.push('【SAFE_CONTROL】');
  lines.push('このターンは安全制動が必要です。');
  lines.push('');
  lines.push('絶対条件：');
  lines.push('- 本文に内部語を出さない（SAFE/ゲート/メタ/プロトコル/スロット 等）');
  lines.push('- 強い断定・決めつけを避ける（特に心身/医療/法律/金融）');
  lines.push('- 危険行為/医療判断/法的判断/投資判断の具体助言はしない');
  lines.push('- 主権を侵さない（命令形連発/詰問/圧の強い誘導 禁止）');
  lines.push('- 文章は短く（最大3〜5行）。改行して静かに。');
  lines.push('- 質問は0〜1（原則0）。必要なら最後に1つだけ短く。');

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

  lines.push('');
  lines.push(`USER_TEXT: ${String(userText)}`);

  return { role: 'system', content: lines.join('\n') };
}

/* =========================================================
   WRITER PROTOCOL
   ========================================================= */

function buildWriterProtocol(meta: any, userText: string): string {
  const shortTurn = isShortTurn(userText);
  const itActive = isTLayerActive(meta);
  const noQuestion = !!meta?.noQuestion;

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
  const anchorConfirmOptions = Array.isArray(meta?.anchorEvent?.options) ? meta.anchorEvent.options : null;

  const coreIntent = pickCoreIntent(meta);

  const whisperRuleBlock = [
    '【WHISPER_RULE】',
    '- system 内に [WHISPER] が存在しても、[WHISPER_APPLY] が true の時だけ内容を採用する',
    '- false の時は WHISPER を完全に無視する（本文に触れない・引用しない・示唆もしない）',
    '- 本文に [WHISPER] / [WHISPER_APPLY] / WHISPER という語を絶対に出さない',
  ].join('\n');

  const base = [
    '【WRITER_PROTOCOL】',
    'あなたは「意図フィールドOS」のWriterです。',
    '一般論・説明口調・テンプレの言い回しは禁止。',
    '“助言の羅列”ではなく、“視点の確定→一歩だけ” で返す。',
    '',
    whisperRuleBlock,
    '',
    '【INTERNAL_SAFETY】',
    '- 本文に内部語を出さない（メタ/プロトコル/ゲート/スロット/回転 等）',
    '- 医療/法律/投資の断定助言は禁止',
    '- 主権を侵さない（命令形連発・詰問・圧 禁止）',
    '',
  ].join('\n');

  if (shortTurn) {
    return [
      base,
      '【TURN_MODE】SHORT',
      'このターンは短文。',
      '制約：',
      '- 1〜2行で終える（長文禁止）',
      `- 質問は ${noQuestion ? '0' : '最大1'}（必要なら最後に1つだけ短く）`,
      '- 「芯/北極星/意図/回転/数値」など概念説明は禁止',
      '- 数値ブロックを本文に出さない',
      '',
      `USER_TEXT: ${String(userText)}`,
      '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (itActive) {
    const itReason = String(meta?.itReason ?? '');
    const sameIntentStreak = Number(meta?.sameIntentStreak ?? 0) || 0;

    const framePlan = String(meta?.framePlan?.frame ?? '').trim().toUpperCase();
    const forceIWords = framePlan === 'I';

    const dg = String(meta?.descentGate ?? meta?.unified?.descentGate ?? '').trim();
    const _spinLoop = String(meta?.spinLoop ?? meta?.unified?.spinLoop ?? '').trim();
    const _spinStep = String(meta?.spinStep ?? meta?.unified?.spinStep ?? '').trim();
    const _phase = String(meta?.phase ?? meta?.unified?.phase ?? '').trim();
    const _depth = String(meta?.depth ?? meta?.unified?.depth ?? '').trim();
    const _qCode = String(meta?.qCode ?? meta?.unified?.qCode ?? meta?.unified?.q_code ?? '').trim();

    return [
      base,
      '【TURN_MODE】IT',
      forceIWords ? '【SUBMODE】I_WORDS' : '',
      'このターンは「意図をたぐる導線」を返す。',
      '解決策の断定・結論化は禁止。代わりに「置ける視点」と「選べる一歩」を返す。',
      '質問攻めは禁止。問いは最大1つ。基本は提案で差し出す。',
      '',
      '出力要件：',
      '- 2〜3行ごとに改行。短く。',
      '- “次の一歩” は1つだけ（戻れる形）。',
      `- 質問は ${noQuestion ? '0' : '最大1'}（原則0）。`,
      '',
      '根拠として内部で使う：',
      `- phase=${_phase} depth=${_depth} q=${_qCode}`,
      `- spinLoop=${_spinLoop} spinStep=${_spinStep} descentGate=${dg}`,
      '根拠の使い方：',
      '- descentGate=closed → “確定”ではなく「選べる形で提示」',
      '- descentGate=offered → 「候補を2つまで」出して比較させる（本文は短く）',
      '- descentGate=accepted → 「反復できる最小ルール」を1つだけ固定する',
      '',
      '禁止：',
      '- 「焦点は〜ではなく〜」構文（テンプレ臭）',
      '- 一般論（落ち着いて等）',
      '- ToDo羅列が続く箇条書き',
      '- 内部語の露出（IT/ゲート/メタ/プロトコル/スロット/回転 等）',
      '- 医療/法律/投資の断定助言',
      '',
      `IT_HINT: reason=${itReason} sameIntentStreak=${String(sameIntentStreak)}`,
      '',
      `USER_TEXT: ${String(userText)}`,
      '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const framePlanForI = String(meta?.framePlan?.frame ?? '').trim().toUpperCase();
  if (framePlanForI === 'I') {
    const dg = String(meta?.descentGate ?? meta?.unified?.descentGate ?? '').trim();
    const _spinLoop = String(meta?.spinLoop ?? meta?.unified?.spinLoop ?? '').trim();
    const _spinStep = String(meta?.spinStep ?? meta?.unified?.spinStep ?? '').trim();
    const _phase = String(meta?.phase ?? meta?.unified?.phase ?? '').trim();
    const _depth = String(meta?.depth ?? meta?.unified?.depth ?? '').trim();
    const _qCode = String(meta?.qCode ?? meta?.unified?.qCode ?? meta?.unified?.q_code ?? '').trim();

    return [
      base,
      '【TURN_MODE】I_FRAME',
      'このターンは「意図を自分の選択として定着させる」ための導線を返す。',
      '解決策の断定・結論化は禁止。代わりに「置ける視点」と「選べる一歩」を返す。',
      '質問攻めは禁止。問いは最大1つ。基本は提案で差し出す。',
      '',
      '出力要件：',
      '- 2〜3行ごとに改行。短く。',
      '- 1行目は「定着」の断定から開始（短く、言い換えで）。',
      '- “次の一歩” は1つだけ（戻れる形）。',
      `- 質問は ${noQuestion ? '0' : '最大1'}（原則0）。`,
      '',
      '根拠として内部で使う：',
      `- phase=${_phase} depth=${_depth} q=${_qCode}`,
      `- spinLoop=${_spinLoop} spinStep=${_spinStep} descentGate=${dg}`,
      '根拠の使い方：',
      '- descentGate=closed → “確定”ではなく「置ける形で提示」',
      '- descentGate=offered → 「候補を2つまで」出して比較させる（本文は短く）',
      '- descentGate=accepted → 「反復できる最小ルール」を1つだけ固定する',
      '',
      '禁止：',
      '- 一般論テンプレ（「大切です」「〜すると良い」「日記」「信頼できる人」「落ち着いて」等）',
      '- ToDo羅列が続く箇条書き',
      '- 内部語の露出（IT/ゲート/メタ/プロトコル/スロット/回転 等）',
      '- 医療/法律/投資の断定助言',
      '',
      `USER_TEXT: ${String(userText)}`,
      '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (!coreIntent) {
    return [
      base,
      '【TURN_MODE】NORMAL',
      'CORE_INTENT は未確定。',
      '',
      'やることは2つだけ：',
      '- 1行目で「いま守りたい一点（北極星）」を自然な日本語で確定する',
      '- 2〜3行目以降で “次の一歩” を1つだけ置く（小さく、戻れる形）',
      '',
      '制約：',
      '- 固定の見出しを毎回必ず出すのは禁止',
      `- 質問は ${noQuestion ? '0' : '最大1'}（詰問禁止。必要なら最後に短く）`,
      '- 断定は強めでよい（「〜してみるといい」より「〜を置く」）',
      '- 一般論/説教/説明口調は禁止',
      '',
      `OBS_META: phase=${String(phase)} depth=${String(depth)} q=${String(qCode)} spinLoop=${String(
        spinLoop,
      )} spinStep=${String(spinStep)} rank=${String(volatilityRank)} direction=${String(
        spinDirection,
      )} promptStyle=${String(promptStyle)}`,
      '',
      `USER_TEXT: ${String(userText)}`,
      '',
    ]
      .filter(Boolean)
      .join('\n');
  }

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
    `ROTATION_META: spinLoop=${String(spinLoop)} spinStep=${String(spinStep)} phase=${String(
      phase,
    )} depth=${String(depth)} q=${String(qCode)} rank=${String(volatilityRank)} direction=${String(
      spinDirection,
    )} promptStyle=${String(promptStyle)}`,
    '',
    `USER_TEXT: ${String(userText)}`,
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

/* =========================================================
   HISTORY → MESSAGES
   ========================================================= */

function normalizeHistoryToMessages(history: unknown, maxItems = 12): ChatMessage[] {
  const src = Array.isArray(history) ? history : [];
  const out: ChatMessage[] = [];

  const pickRole = (v: any): 'user' | 'assistant' | null => {
    const r = v?.role ?? v?.sender ?? v?.from ?? v?.type ?? null;
    if (r === 'system') return null;
    if (r === 'user' || r === 'human') return 'user';
    if (r === 'assistant' || r === 'ai' || r === 'bot') return 'assistant';
    return null;
  };

  const pickText = (v: any): string | null => {
    if (typeof v === 'string') return v;
    if (!v) return null;

    const c =
      (typeof v.content === 'string' && v.content) ||
      (typeof v.text === 'string' && v.text) ||
      (typeof v.message === 'string' && v.message) ||
      (typeof v.body === 'string' && v.body) ||
      (typeof v.value === 'string' && v.value) ||
      null;

    if (c) return c;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return null;
  };

  const tail = src.slice(Math.max(0, src.length - maxItems));
  for (const item of tail) {
    const role = pickRole(item);
    const text = pickText(item);
    if (!role || !text) continue;
    out.push({ role, content: text });
  }

  return out;
}

function dedupeTailUser(historyMessages: ChatMessage[], userText: string): ChatMessage[] {
  if (historyMessages.length === 0) return historyMessages;

  const last = historyMessages[historyMessages.length - 1];
  if (last.role !== 'user') return historyMessages;

  const lastText = String((last as any).content ?? '').trim();
  if (!lastText) return historyMessages;

  if (lastText === String(userText ?? '').trim()) return historyMessages.slice(0, -1);
  return historyMessages;
}

// ==============================
// Frame / Slots hint (Writer)
// ==============================

type FrameKind = 'S' | 'R' | 'C' | 'I' | 'T' | 'F' | 'MICRO' | 'NONE';

function normalizeFrameKind(v: unknown): FrameKind | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (s === 'S' || s === 'R' || s === 'C' || s === 'I' || s === 'T' || s === 'F' || s === 'MICRO' || s === 'NONE') {
    return s as FrameKind;
  }
  return null;
}

function extractSlotKeys(v: any): string[] {
  if (!v) return [];

  if (Array.isArray(v)) {
    return v.map((s: any) => (typeof s?.key === 'string' ? s.key : null)).filter(Boolean);
  }

  if (typeof v === 'object') {
    const maybeSlots = (v as any).slots;
    if (maybeSlots && typeof maybeSlots === 'object' && !Array.isArray(maybeSlots)) {
      return Object.entries(maybeSlots)
        .filter(([, vv]) => !!vv)
        .map(([k]) => k);
    }

    return Object.entries(v)
      .filter(([, vv]) => !!vv)
      .map(([k]) => k);
  }

  return [];
}

function buildWriterHintsFromMeta(meta: any): {
  frame: FrameKind | null;
  slotKeys: string[];
  hintText: string | null;
} {
  const fp = meta?.framePlan && typeof meta.framePlan === 'object' ? meta.framePlan : null;

  const itActive = isTLayerActive(meta);
  const whisperApply = itActive;

  console.log('[IROS/frame-debug] input', {
    meta_frame_before: meta?.frame ?? null,
    framePlan_frame: fp?.frame ?? null,
    framePlan_slots_keys: extractSlotKeys(fp?.slots),
    slotPlan_keys: extractSlotKeys(meta?.slotPlan),
    itActive,
    whisperApply,
  });

  const frameFromPlan = itActive ? ('T' as FrameKind) : normalizeFrameKind(fp?.frame);
  const frameFromMeta = normalizeFrameKind(meta?.frame);
  const frame: FrameKind | null = frameFromPlan ?? frameFromMeta ?? null;

  console.log('[IROS/frame-debug] decided', {
    frameFromPlan: frameFromPlan ?? null,
    meta_frame_before: meta?.frame ?? null,
    decided_frame: frame,
  });

  const slotKeysFromPlan = extractSlotKeys(fp?.slots);
  const slotKeysFromMeta = extractSlotKeys(meta?.slotPlan);
  const slotKeys = slotKeysFromPlan.length > 0 ? slotKeysFromPlan : slotKeysFromMeta;

  if (!frame && slotKeys.length === 0) {
    return { frame: null, slotKeys: [], hintText: null };
  }

  const frameGuide: Record<FrameKind, string> = {
    S: '自己の内側（観測→整える）を短く深く',
    R: '状況/相手/関係（接続→見取り図）を中心に',
    C: '具体の実行案（手順/次の一歩）を中心に',
    I: '意図/軸（なぜ/何のため）を中心に',
    T: 'ひらめき/視点上昇（俯瞰→再定義）を中心に',
    F: '焦点化（問いの器）を中心に',
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

function pickRecentUserQsFromHistory(history: any[], take = 3): string[] {
  const out: string[] = [];
  const hs = Array.isArray(history) ? history : [];

  for (let i = 0; i < hs.length; i++) {
    const m = hs[i];
    if (!m) continue;

    const role = String(m.role ?? '').toLowerCase();
    if (role !== 'user') continue;

    const qRaw =
      (m.q_code ?? null) ??
      (m.q ?? null) ??
      (m.qCode ?? null) ??
      (m.meta?.qCode ?? null) ??
      (m.meta?.q_code ?? null) ??
      (m.meta?.q ?? null);

    const q = normalizeQ(qRaw);
    if (!q) continue;

    out.push(q);
    if (out.length > take) out.splice(0, out.length - take);
  }

  return out;
}

/* =========================================================
   SpeechAct input builder
   ========================================================= */

function hasFixedAnchor(meta: any): boolean {
  const t1 = typeof meta?.intent_anchor?.text === 'string' ? meta.intent_anchor.text.trim() : '';
  const t2 = typeof meta?.unified?.intent_anchor?.text === 'string' ? meta.unified.intent_anchor.text.trim() : '';
  const t3 = typeof meta?.intentAnchor?.text === 'string' ? meta.intentAnchor.text.trim() : '';
  return !!(t1 || t2 || t3);
}

function pickInputKind(meta: any): string | null {
  const v =
    (typeof meta?.inputKind === 'string' && meta.inputKind) ||
    (typeof meta?.framePlan?.frame === 'string' && meta.framePlan.frame.toUpperCase() === 'MICRO' ? 'micro' : '') ||
    (typeof meta?.extra?.inputKind === 'string' && meta.extra.inputKind) ||
    null;
  return v ? String(v) : null;
}

function pickBrakeReason(meta: any): string | null {
  const r =
    (typeof meta?.extra?.brakeReleaseReason === 'string' && meta.extra.brakeReleaseReason) ||
    (typeof meta?.extra?.brake_release_reason === 'string' && meta.extra.brake_release_reason) ||
    null;
  return r ? String(r) : null;
}

function computeSlotPlanLen(meta: any): number | null {
  const fpSlots = extractSlotKeys(meta?.framePlan?.slots);
  if (fpSlots.length > 0) return fpSlots.length;

  const sp = extractSlotKeys(meta?.slotPlan);
  if (sp.length > 0) return sp.length;

  const fs = extractSlotKeys(meta?.frameSlots);
  if (fs.length > 0) return fs.length;

  return 0;
}

function buildDecideSpeechActInput(meta: any, userText: string): DecideSpeechActInput {
  const shortTurn = isShortTurn(userText);

  return {
    inputKind: pickInputKind(meta),
    brakeReleaseReason: pickBrakeReason(meta),
    generalBrake:
      (typeof meta?.extra?.generalBrake === 'string' && meta.extra.generalBrake) ||
      (typeof meta?.extra?.general_brake === 'string' && meta.extra.general_brake) ||
      null,
    slotPlanLen: computeSlotPlanLen(meta),
    itActive: isTLayerActive(meta),
    tLayerModeActive: meta?.tLayerModeActive === true,
    tLayerHint: typeof meta?.tLayerHint === 'string' ? meta.tLayerHint : null,
    hasFixedAnchor: hasFixedAnchor(meta),
    oneLineOnly: shortTurn || meta?.oneLineOnly === true,
    userText,
  };
}

// =========================================================
//   SpeechAct final sync (決定/適用/最終を一致させる)
//   ✅ setSpeechActTrace はこの1個だけに統一する
// =========================================================

function setSpeechActTrace(
  meta: any,
  args: {
    decisionAct?: any;
    appliedAct?: any;
    finalAct?: any;
    reason?: any;
    confidence?: any;
  },
) {
  if (!meta || typeof meta !== 'object') return;
  const ex =
    typeof meta.extra === 'object' && meta.extra ? meta.extra : (meta.extra = {});

  // ✅ legacy互換：speechAct は「final があれば final / なければ applied」
  if (args.finalAct != null) ex.speechAct = args.finalAct;
  else if (args.appliedAct != null) ex.speechAct = args.appliedAct;

  // ✅ v2 trace（ズレ検知の本命）
  if (args.decisionAct != null) ex.speechActDecision = args.decisionAct;
  if (args.appliedAct != null) ex.speechActApplied = args.appliedAct;
  if (args.finalAct != null) ex.speechActFinal = args.finalAct;

  if (args.reason != null) ex.speechActReason = args.reason;
  if (args.confidence != null) ex.speechActConfidence = args.confidence;
}

/* =========================================================
   MAIN
   ========================================================= */

export async function generateIrosReply(args: GenerateArgs): Promise<GenerateResult> {
  // ✅ Partial meta を IntentMeta に正規化してから使う
  const meta: IrosMeta = normalizeIntentMeta(args.meta);
  const userText = String((args as any).text ?? (args as any).userText ?? '');

  // ✅ v2: meta は常に object に正規化（null/undefined を許可しない）
  // - 以降は meta / meta.extra を “必ず” 触れる前提にする
  const _metaAny: any =
    meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  (args as any).meta = _metaAny; // 念のため（参照が args 側のときもある）
  const metaRef: any = _metaAny;

  // meta 参照を metaRef に統一（この関数内でのみ）
  // ※ TypeScript的に meta を const のまま維持するため別名で固定
  metaRef.extra = metaRef.extra && typeof metaRef.extra === 'object' ? metaRef.extra : {};

  // =========================================================
  // MemoryState attach (generate side)
  // =========================================================
  const memoryStateFromArgs = (args as any)?.memoryState ?? null;

  // ✅ 代入は metaRef に統一（meta が object でない事故でも落ちない）
  if (memoryStateFromArgs && typeof memoryStateFromArgs === 'object' && !metaRef.memoryState) {
    metaRef.memoryState = memoryStateFromArgs;
  }

  if (
    !metaRef.q_counts &&
    metaRef.memoryState?.q_counts &&
    typeof metaRef.memoryState.q_counts === 'object'
  ) {
    metaRef.q_counts = metaRef.memoryState.q_counts;
  }

  // ==============================
  // Frame sticky を断つ（重要）
  // ==============================
  delete metaRef.frame;
  delete metaRef.slots;
  delete metaRef.frameSlots;

  /* ---------------------------------
     QTrace / QNow / recentUserQs
  --------------------------------- */

  const qTrace: any = (meta as any)?.qTrace ?? null;

  const qNow: string | null = normalizeQ((meta as any)?.qPrimary ?? (meta as any)?.q_code ?? qTrace?.lastQ ?? null);

  /* ---------------------------------
     history から拾う
  --------------------------------- */
  const recentUserQs = pickRecentUserQsFromHistory((args as any).history, 3);

  /* ---------------------------------
     “実ユーザー2連” 判定用の系列を作る（history + 今回）
  --------------------------------- */
  const qSeqForTurn = [...recentUserQs, qNow].filter(Boolean) as string[];
  const qSeq3 = qSeqForTurn.slice(-3);

  /* ---------------------------------
     Qブレーキ判定（系列は qSeq3 を使う）
  --------------------------------- */
  const qBrake = decideQBrakeRelease({
    qNow,
    sa: (meta as any)?.selfAcceptance ?? null,
    recentUserQs: qSeq3,
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

    console.log('[IROS][QBrakeRelease][generate] ON', { qNow, reason: qBrake.reason, detail: qBrake.detail, recentUserQs });
  } else {
    console.log('[IROS][QBrakeRelease][generate] OFF', { qNow, reason: qBrake.reason, detail: qBrake.detail, recentUserQs });
  }

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

  // ✅ Writer protocol
  const protocol = buildWriterProtocol(meta as any, userText);

  // ---------------------------------
  // ✅ SpeechAct: LLM前に確定 → 適用（単一ソース）
  // ---------------------------------
  const speechInput = buildDecideSpeechActInput(meta as any, userText);
  const speechDecision: SpeechDecision = decideSpeechAct(speechInput);
  const speechApplied = applySpeechAct(speechDecision);

  // ✅ 最終ルール：applySpeechAct の結果だけを単一ソースにする
  let finalAllowLLM = speechApplied.allowLLM === true;

  // ✅ meta.extra に証拠を刻む（DBで追跡できるように）
  // - ※ finalAct はこの時点では未確定（enforce後に確定する）
  setSpeechActTrace(meta as any, {
    decisionAct: (speechDecision as any).act,
    appliedAct: (speechApplied as any).act,
    finalAct: null,
    reason: (speechDecision as any).reason,
    confidence: typeof (speechDecision as any).confidence === 'number' ? (speechDecision as any).confidence : null,
  });

  // allowLLM / input は従来どおり
  if (meta && typeof meta === 'object') {
    const ex =
      typeof (meta as any).extra === 'object' && (meta as any).extra ? (meta as any).extra : ((meta as any).extra = {});
    ex.speechAllowLLM = finalAllowLLM;
    ex.speechInput = speechInput;

    // ✅ 追加：writerAssert（灯台に沿って “言い切ってよい” 許可）
    // - 最初はゆるく：LLMが許可されるなら ALLOW（制約は後から足す）
    ex.writerAssert = finalAllowLLM ? 'ALLOW' : 'DENY';
    ex.writerAssertReason = 'SPEECH_ALLOW_LLM_SINGLE_SOURCE';
  }


  console.log('[IROS/SpeechAct] decided', {
    act: (speechApplied as any).act,
    decisionAct: (speechDecision as any).act,
    reason: (speechDecision as any).reason,
    confidence: (speechDecision as any).confidence ?? null,
    input: speechInput,
    allowLLM: finalAllowLLM,

    // ✅ 追加：灯台フラグの証明（meta.extra と一致するはず）
    writerAssert: finalAllowLLM ? 'ALLOW' : 'DENY',
    writerAssertReason: 'SPEECH_ALLOW_LLM_SINGLE_SOURCE',
  });


// ✅ 置き換え対象：src/lib/iros/generate.ts のこのブロック
// 1015〜1041行あたり（あなたが貼った範囲の「// ✅ LLMを呼ばない場合（act別に返す）」〜 textOut 決定部）
//
// 目的：
// - 非LLM本文の生成を廃止（SILENCE専用）
// - finalAllowLLM=false の場合は、actが何であっても “無音(ゼロ幅)” を返す
// - fallbackNormalBody をここから完全排除

// ✅ LLMを呼ばない場合（SILENCE専用で返す）
if (!finalAllowLLM) {
  const safeMeta = typeof meta === 'object' && meta !== null ? meta : ({} as any);
  const ex =
    typeof (safeMeta as any).extra === 'object'
      ? (safeMeta as any).extra
      : ((safeMeta as any).extra = {});

  const SILENT_BODY = '\u200B'; // 見た目は空、しかし "" ではない

  // ✅ 非LLMで本文を返すのは禁止（Phase1：SILENCE専用）
  // act が FORWARD 等でも、ここでは無音に潰して “テンプレ混入経路” を遮断する
  const finalAct = 'SILENCE';
  const textOut = SILENT_BODY;

  ex.speechSkipped = true;
  ex.speechSkippedText = textOut;
  ex.rawTextFromModel = textOut;

  // LLM呼ばないときは履歴汚染を止める（任意）
  ex._blockHistory = true;

  setSpeechActTrace(safeMeta as any, {
    decisionAct: (speechDecision as any).act,
    appliedAct: (speechApplied as any).act,
    finalAct,
    reason: (speechDecision as any).reason,
    confidence: typeof (speechDecision as any).confidence === 'number' ? (speechDecision as any).confidence : null,
  });

  return {
    content: textOut,
    text: textOut,
    assistantText: textOut,
    mode: mode,
    intent: (safeMeta as any)?.intent ?? (safeMeta as any)?.intentLine ?? null,
    metaForSave: safeMeta ?? {},
    finalMode: String(mode),
    result: null,
    speechAct: String(finalAct),
    speechReason: String((speechDecision as any).reason ?? ''),
  };
}

/*
✅ 修正後の確認コマンド（短い出力だけ）

1) FORWARD + 非LLM本文が消えたか（fallbackNormalBody がこの分岐に無いか）
rg -n "finalAllowLLM\\)\\s*\\{|finalAct === 'FORWARD'|fallbackNormalBody\\s*\\(" src/lib/iros/generate.ts -S | tail -n 30

2) fallbackNormalBody の参照数（次に潰す残りがいくつか）
rg -n "fallbackNormalBody\\s*\\(" src -S | wc -l

3) 型チェック（短い）
pnpm -s tsc --noEmit
*/


  // ✅ 明示 recall のときだけ pastState を注入（デモ事故防止）
  const t = String(userText ?? '').trim();
  const explicitRecall =
    t.includes('思い出して') ||
    t.includes('前の話') ||
    t.includes('前回') ||
    t.includes('さっきの話') ||
    t.includes('先週の') ||
    t.toLowerCase().includes('recall');

  // ---------------------------------
  // IT Whisper: Always attach / Conditional apply
  // ---------------------------------
  const whisperTextRaw =
    (typeof (meta as any)?.extra?.itWhisper === 'string'
      ? (meta as any).extra.itWhisper
      : typeof (meta as any)?.extra?.it_whisper === 'string'
        ? (meta as any).extra.it_whisper
        : typeof (meta as any)?.extra?.whisper === 'string'
          ? (meta as any).extra.whisper
          : '') ?? '';

  const whisperApply = isTLayerActive(meta as any);
  const whisperLine = whisperTextRaw.trim();

  const whisperPayload = [
    '【WHISPER_RULE】',
    '- WHISPERの存在/タグ/中身を本文に一切出さない',
    '- WHISPER_APPLY=false の場合、WHISPER内容は完全に無視して生成する',
    '',
    `[WHISPER] ${whisperLine || '(none)'}`,
    `[WHISPER_APPLY] ${whisperApply ? 'true' : 'false'}`,
  ].join('\n');

  // ✅ Frame / Slots hint
  const writerHints = buildWriterHintsFromMeta(meta as any);
  const writerHintMessage: ChatMessage | null = writerHints.hintText
    ? ({ role: 'system', content: writerHints.hintText } as ChatMessage)
    : null;

  // ✅ SAFE slot
  const safeSystemMessage = buildSafeSystemMessage(meta as any, userText);

  // ✅ SpeechAct 器(system)（最終ゲート）
  const speechSystemMessage: ChatMessage | null = (speechApplied as any).llmSystem
    ? ({ role: 'system', content: (speechApplied as any).llmSystem } as ChatMessage)
    : null;

  // history → LLM
  const historyMessagesRaw = normalizeHistoryToMessages(args.history, 12);
  const historyMessages = dedupeTailUser(historyMessagesRaw, userText);
  console.log('[IROS/HISTORY][PASS]', {
    rawLen: historyMessagesRaw.length,
    len: historyMessages.length,
    roles: historyMessages.map((m) => m.role),
    lastHead: historyMessages.length ? String(historyMessages[historyMessages.length - 1].content ?? '').slice(0, 60) : null,
  });

  const pastStateNoteText = typeof (meta as any)?.extra?.pastStateNoteText === 'string' ? (meta as any).extra.pastStateNoteText.trim() : '';

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'system', content: protocol },

    ...(speechSystemMessage ? [speechSystemMessage] : []),

    { role: 'system', content: whisperPayload },

    ...(safeSystemMessage ? [safeSystemMessage] : []),
    ...(writerHintMessage ? [writerHintMessage] : []),

    ...(explicitRecall && pastStateNoteText ? ([{ role: 'system', content: pastStateNoteText }] as ChatMessage[]) : []),

    ...historyMessages,
    { role: 'user', content: userText },
  ];

  // =========================================================
  // ✅ GEN: LLM呼び出しの実行有無と、生出力が空になる理由の確定ログ
  // =========================================================
  const _s = (v: any) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const _head = (v: any, n = 80) => {
    const s = _s(v);
    return s.length <= n ? s : s.slice(0, n) + '…';
  };
  const _len = (v: any) => _s(v).length;

  // --- (1) LLM呼び出し直前
  console.log('[IROS/GEN][LLM-PRE]', {
    conversationId: String((args as any)?.conversationId ?? ''),
    inputKind: (meta as any)?.inputKind ?? null,
    speechAct: (meta as any)?.extra?.speechAct ?? null,
    speechActFinal: (meta as any)?.extra?.speechActFinal ?? null,
    speechAllowLLM: (meta as any)?.extra?.speechAllowLLM ?? null,
    userText_len: _len(userText),
    userText_head: _head(userText),
    history_len: Array.isArray((args as any)?.history) ? (args as any).history.length : null,
    messages_len: Array.isArray(messages) ? messages.length : null,
  });

  // ---- LLM call（✅ 1回だけ / ✅ chatComplete 経由）
  const raw = await chatComplete({
    apiKey: process.env.OPENAI_API_KEY!,
    purpose: 'reply',
    model: IROS_MODEL,
    messages,
    temperature: (speechDecision as any).act === 'COMMIT' ? 0.7 : 0.35,
  });

  // --- (2) LLM呼び出し直後（rawを“ここで”確定）
  console.log('[IROS/GEN][LLM-POST]', {
    raw_len: _len(raw),
    raw_head: _head(raw),
  });

  // ✅ Phase1: LLM経路では非LLM本文(fallbackNormalBody)を混ぜない
  // - 空のときは最小プレースホルダ '…' のみで non-empty を保証する
  let content = ensureNonEmpty(raw, '…');

  // v2: rawTextFromModel は「LLMの生出力」を必ず保存（空は禁止）
  // - raw が空なら '…' を入れる（content 参照で fallback が混ざる余地を消す）
  if (meta && typeof meta === 'object') {
    const ex =
      typeof (meta as any).extra === 'object' && (meta as any).extra
        ? (meta as any).extra
        : ((meta as any).extra = {});
    ex.rawTextFromModel = ensureNonEmpty(raw, '…');
  }


  // ---------------------------------
  // ✅ Enforce AllowSchema（最終ゲート） + non-empty保証
  // ---------------------------------
  const enforced = enforceAllowSchema((speechApplied as any).allow as any, content);

  // ✅ 最終act（返却/保存/UIの単一ソース）
  let finalAct: any = (enforced as any).act;

  // Decision が SILENCE でない限り、enforce の SILENCE は無効
  if ((speechDecision as any).act !== 'SILENCE' && (enforced as any).act === 'SILENCE') {
    const origin = ensureNonEmpty(content, '…');
    const kept = ensureNonEmpty((enforced as any).text, '');

    const fallbackLine = firstNonEmptyLine(origin) ?? firstNonEmptyLine(kept) ?? '…';
    content = ensureNonEmpty(fallbackLine, '…');

    finalAct = (speechDecision as any).act;

    console.log('[IROS/SpeechAct] enforce returned SILENCE but overridden (non-silence decision)', {
      decisionAct: (speechDecision as any).act,
      enforcedAct: (enforced as any).act,
      allowAct: (speechApplied as any)?.allow?.act ?? null,
      used: 'fallbackLine',
      originLen: origin.length,
      keptLen: kept.length,
    });
  } else {
    const enforcedText = ensureNonEmpty((enforced as any).text, '');
    const origin = ensureNonEmpty(content, '…');
    content = ensureNonEmpty(enforcedText || origin, '…');
    finalAct = (enforced as any).act;
  }

  (enforced as any).act = finalAct;

  // ✅ ここで「最終act」を meta に確定保存（ズレを潰す本命）
  setSpeechActTrace(meta as any, {
    decisionAct: (speechDecision as any).act,
    appliedAct: (speechApplied as any).act,
    finalAct,
    reason: (speechDecision as any).reason,
    confidence: typeof (speechDecision as any).confidence === 'number' ? (speechDecision as any).confidence : null,
  });

  /* ---------------------------------
     Numeric footer
  --------------------------------- */

  const showNumericFooter = process.env.IROS_NUMERIC_FOOTER === '1' || (meta as any)?.extra?.showNumericFooter === true;

  const hardHideNumericFooter =
    (meta as any)?.microOnly === true ||
    (meta as any)?.recallOnly === true ||
    String(mode) === 'recall' ||
    (speechDecision as any).act !== 'COMMIT';

  if (showNumericFooter && !hardHideNumericFooter) {
    content = content.replace(/\n*\s*[〔\[]sa[^\n]*[〕\]]\s*$/g, '').trim();

    const footer = buildNumericFooter(meta as any);
    if (footer) {
      content = `${ensureNonEmpty(content, '…')}\n${footer}`;
    }
  }

  // ✅ 最終ガード：返却本文は必ず非空（Phase1）
  // - LLM経路では非LLM本文（fallbackNormalBody）を混ぜない
  // - 空なら最小プレースホルダ '…' のみ
  // - SILENCE は上流（finalAllowLLM=false 分岐）でゼロ幅に潰している
  content = ensureNonEmpty(content, '…');


  return {
    content,
    text: content,
    assistantText: content,
    mode,
    intent: (meta as any)?.intent ?? (meta as any)?.intentLine ?? null,
    metaForSave: meta ?? {},
    finalMode: String(mode),
    result: null,

    // ✅ 返却も「最終act」に統一（ここが修正の本丸）
    speechAct: String(finalAct ?? (speechApplied as any).act ?? (speechDecision as any).act ?? ''),
    speechReason: String((speechDecision as any).reason ?? ''),
  };
}
