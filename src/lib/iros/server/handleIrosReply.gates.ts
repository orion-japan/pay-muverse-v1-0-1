// file: src/lib/iros/server/handleIrosReply.gates.ts
// iros - Gates (Greeting / Micro)

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  HandleIrosReplySuccess,
  HandleIrosReplyOutput,
} from './handleIrosReply';

// ✅ 追加：保存は persist.ts に一本化
import { persistAssistantMessage } from './handleIrosReply.persist';

export type GateBaseArgs = {
  supabase: SupabaseClient;
  conversationId: string;
  userCode: string;
  text: string;
  userProfile?: { user_call_name?: string | null } | null;
  reqOrigin: string;
  authorizationHeader: string | null;
};

export type MicroGateArgs = GateBaseArgs & {
  traceId?: string | null;
};

const GREETINGS = new Set(['こんばんは', 'こんにちは', 'おはよう']);

function normalizeTailPunct(s: string): string {
  return (s ?? '').trim().replace(/[！!。．…]+$/g, '').trim();
}

function normalizeMicro(s: string): string {
  return normalizeTailPunct(s);
}

function buildMicroCore(raw: string) {
  const rawTrim = (raw ?? '').trim();
  const hasQuestion = /[?？]$/.test(rawTrim);

  const core = normalizeMicro(rawTrim)
    .replace(/[?？]/g, '')
    .replace(/\s+/g, '')
    .trim();

  return { rawTrim, hasQuestion, core, len: core.length };
}

// かんたんハッシュ（テンプレ感を減らすための“揺らぎ”用）
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickVariant(seed: string, variants: string[]): string {
  return variants.length ? variants[hash32(seed) % variants.length] : '';
}

// Micro gate は「決める/動く」系だけに限定（疲れ/休みは通常LLMへ流す）
function isMicroTurn(raw: string): boolean {
  const { rawTrim, core, len } = buildMicroCore(raw);
  if (!rawTrim) return false;

  // ★ 保険：アルファベット/数字混在は micro にしない（知的質問・固有名詞を弾く）
  if (/[A-Za-z0-9]/.test(core)) return false;

  // ★ 保険：質問語彙っぽいものは micro にしない（例: 何色？など）
  if (/(何|なに|どこ|いつ|だれ|誰|なぜ|どうして|どうやって|いくら|何色|色)/.test(core)) {
    return false;
  }

  // 超短文だけ
  if (len < 2 || len > 10) return false;

  // 語彙一致のみ（?だけで micro にしない）
  return /^(どうする|やる|やっちゃう|いく|いける|どうしよ|どうしよう|行く|行ける)$/.test(core);
}

/* =====================================================
   Greeting gate: 挨拶は「完全一致のみ」で返す（記憶・意図・深度に触れない）
===================================================== */
export async function runGreetingGate(
  args: GateBaseArgs,
): Promise<HandleIrosReplyOutput | null> {
  const {
    supabase,
    conversationId,
    text,
    userCode,
    userProfile,
    reqOrigin,
    authorizationHeader,
  } = args;

  const greeting = normalizeTailPunct(text);
  const isGreeting = GREETINGS.has(greeting);
  if (!isGreeting) return null;

  const name = userProfile?.user_call_name || 'あなた';
  const assistantText = `${greeting}、${name}さん。`;

  const metaForSave = {
    mode: 'light',
    greetingOnly: true,
    skipMemory: true,
    skipTraining: true,
    nextStep: null,
    next_step: null,
  };

  const result = { content: assistantText, meta: metaForSave, mode: 'light' };

  console.log('[IROS/GreetingGate] matched exact greeting', {
    userCode,
    greeting,
  });

  // ✅ 保存経路を統一（persist.ts）
  await persistAssistantMessage({
    supabase,
    reqOrigin,
    authorizationHeader,
    conversationId,
    userCode,
    assistantText,
    metaForSave,
  });

  const out: HandleIrosReplySuccess = {
    ok: true,
    result,
    assistantText,
    metaForSave,
    finalMode: 'light',
  };

  return out;
}

/* =====================================================
   Micro gate: 超短文は「軽量・間の返し」で返す
===================================================== */
export async function runMicroGate(
  args: MicroGateArgs,
): Promise<HandleIrosReplyOutput | null> {
  const {
    supabase,
    conversationId,
    text,
    userCode,
    userProfile,
    reqOrigin,
    authorizationHeader,
    traceId,
  } = args;

  if (!isMicroTurn(text)) return null;

  const name = userProfile?.user_call_name || 'あなた';
  const { core, hasQuestion } = buildMicroCore(text);

  const isActionCore = /^(やる|やっちゃう|いく|いける|行く|行ける)$/.test(core);
  const isDecisionQuestion = /^(どうする|どうしよ|どうしよう)$/.test(core);

  // 同じ入力でも“毎ターン揺らぐ”seed
  const seed = `${conversationId}|${userCode}|${traceId ?? ''}|${Date.now()}`;

  const lead = pickVariant(seed, [
    `${name}さん。「${core}${hasQuestion ? '？' : ''}」って出たね。`,
    `${name}さん、いま “${core}” のスイッチが入った。`,
    `${name}さん、短くても十分伝わった。`,
  ]);

  const actionOptions = pickVariant(seed + '|a', [
    `① いま行く（小さく着手）\n② 30秒だけ整える\n③ 今日は畳む（回復優先）`,
    `A いま / B 30秒整える / C 今日は置く`,
    `① まず一手\n② まず整える\n③ まず休む`,
  ]);

  const questionOptions = pickVariant(seed + '|q', [
    `① いま決める\n② 30秒だけ整えてから決める\n③ 今日は決めない`,
    `A いま決める / B 30秒後 / C 今日は保留`,
  ]);

  const tail = pickVariant(seed + '|t', [
    `→ どれが近い？`,
    `→ いちばん近いのだけ返して`,
    `→ A/B/C（または①②③）でOK`,
  ]);

  const pickedOptions = isActionCore
    ? actionOptions
    : isDecisionQuestion
      ? questionOptions
      : actionOptions;

  const assistantText = `${lead}\n${pickedOptions}\n${tail}`;

  const metaForSave = {
    mode: 'light',
    microOnly: true,
    skipMemory: true,
    skipTraining: true,
    nextStep: null,
    next_step: null,
  };

  const result = { content: assistantText, meta: metaForSave, mode: 'light' };

  console.log('[IROS/MicroGate] matched micro input', { userCode, text, core });

  // ✅ 保存経路を統一（persist.ts）
  await persistAssistantMessage({
    supabase,
    reqOrigin,
    authorizationHeader,
    conversationId,
    userCode,
    assistantText,
    metaForSave,
  });

  const out: HandleIrosReplySuccess = {
    ok: true,
    result,
    assistantText,
    metaForSave,
    finalMode: 'light',
  };

  return out;
}
