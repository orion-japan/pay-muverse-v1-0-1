// src/lib/iros/soul/runIrosSoul.ts
// Iros 魂レイヤー本体呼び出し
// - Silent Advisor として JSON だけを返す LLM を叩き、IrosSoulNote にパースする
//
// ✅ 方針
// - response_format(json_object) を指定して JSON 崩れを抑制
// - 返却オブジェクトをスキーマ検証＋正規化（tone_hint / 配列 / 必須キー）
// - 旧tone_hint("light","firm") を新4択("minimal","gentle","normal","soft")へマッピング
// - 余計なキーは捨てる（安全にクランプ）
// - JSON.parse 失敗時のフォールバック維持
//
// ✅ 重要
// - このファイル内の `any` を排除（response_format も含めて型安全に）

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat';

import type { IrosSoulInput, IrosSoulNote } from './types';
import { buildIrosSoulMessages } from './system';

// 使用モデル
const IROS_SOUL_MODEL =
  process.env.IROS_SOUL_MODEL ??
  process.env.IROS_MODEL ??
  process.env.OPENAI_MODEL ??
  'gpt-4o';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export type RunIrosSoulOptions = {
  debugLog?: (label: string, payload: unknown) => void;
};

type ToneHintV2 = IrosSoulNote['tone_hint'];

// 旧互換の tone_hint を新4択へ吸収
function normalizeToneHint(v: unknown): ToneHintV2 {
  if (v === 'minimal' || v === 'gentle' || v === 'normal' || v === 'soft') {
    return v;
  }
  // 旧/ブレ値の吸収
  if (v === 'light') return 'gentle';
  if (v === 'firm') return 'normal';
  // 未知は安全側（やさしめ）
  return 'gentle';
}

function normalizeStringOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function normalizeStringArrayOrNull(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const arr = v
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.length > 0);
  return arr.length > 0 ? arr : null;
}

function normalizeStringArray(v: unknown): string[] {
  return normalizeStringArrayOrNull(v) ?? [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Iros 魂LLMを実行して、IrosSoulNote を返す
 * - 失敗時は null を返し、本体は通常フローのみで動作させる
 */
export async function runIrosSoul(
  input: IrosSoulInput,
  options?: RunIrosSoulOptions,
): Promise<IrosSoulNote | null> {
  const debugLog = options?.debugLog;

  try {
    const messages = buildIrosSoulMessages(input) as ChatCompletionMessageParam[];

    if (process.env.DEBUG_IROS_SOUL === '1') {
      console.log('[IROS/Soul] request', { input });
    }
    debugLog?.('[IROS/Soul] request', { input });

    const res = await client.chat.completions.create({
      model: IROS_SOUL_MODEL,
      messages,
      temperature: 0,
      // JSON 崩れ対策（モデルが対応していれば JSON object で返る）
      response_format: { type: 'json_object' },
    });

    const raw = res.choices?.[0]?.message?.content?.toString().trim() ?? '';

    if (process.env.DEBUG_IROS_SOUL === '1') {
      console.log('[IROS/Soul] raw', raw);
    }
    debugLog?.('[IROS/Soul] raw', raw);

    if (!raw) return null;

    // まず素直に JSON.parse を試す
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 失敗した場合は、テキスト中の最初の {...} を拾って再パースを試みる
      const match = raw.match(/{[\s\S]*}/);
      if (!match) return null;

      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return null;
      }
    }

    if (!isRecord(parsed)) return null;

    const note = normalizeSoulNote(parsed, debugLog);
    if (!note) return null;

    if (process.env.DEBUG_IROS_SOUL === '1') {
      console.log('[IROS/Soul] note', note);
    }
    debugLog?.('[IROS/Soul] note', note);

    return note;
  } catch (e) {
    if (process.env.DEBUG_IROS_SOUL === '1') {
      console.error('[IROS/Soul] error', e);
    }
    debugLog?.('[IROS/Soul] error', e);
    return null;
  }
}

/**
 * LLM から返ってきたオブジェクトを IrosSoulNote 型にクランプ
 *
 * - 必須: core_need（空なら null）
 * - tone_hint: v2 4択へ正規化（旧light/firmも救済）
 * - risk_flags: string[] に正規化（空配列OK）
 * - 余計なキーは無視
 */
function normalizeSoulNote(
  raw: Record<string, unknown>,
  debugLog?: (label: string, payload: unknown) => void,
): IrosSoulNote | null {
  const core_need = normalizeStringOrNull(raw.core_need);
  if (!core_need) {
    debugLog?.('[IROS/Soul] invalid: missing core_need', { raw });
    return null;
  }

  const tone_hint = normalizeToneHint(raw.tone_hint);
  const risk_flags = normalizeStringArray(raw.risk_flags);

  // Optional fields
  const step_phrase = normalizeStringOrNull(raw.step_phrase);
  const soul_sentence = normalizeStringOrNull(raw.soul_sentence);
  const notes = normalizeStringOrNull(raw.notes);

  const micro_steps = normalizeStringArrayOrNull(raw.micro_steps);
  const comfort_phrases = normalizeStringArrayOrNull(raw.comfort_phrases);

  const alignmentRaw = normalizeStringOrNull(raw.alignment);
  const alignment: IrosSoulNote['alignment'] =
    alignmentRaw === 'with' || alignmentRaw === 'against' || alignmentRaw === 'foggy'
      ? alignmentRaw
      : undefined;

  const subjectRaw = normalizeStringOrNull(raw.subject_stance);
  const subject_stance: IrosSoulNote['subject_stance'] =
    subjectRaw === 'receive' || subjectRaw === 'activate' ? subjectRaw : undefined;

  const note: IrosSoulNote = {
    core_need,
    risk_flags,
    tone_hint,
    step_phrase,
    micro_steps,
    comfort_phrases,
    soul_sentence,
    notes,
    alignment,
    subject_stance,
  };

  // 変換が発生したらログ
  if (raw.tone_hint !== tone_hint) {
    debugLog?.('[IROS/Soul] tone_hint normalized', {
      from: raw.tone_hint,
      to: tone_hint,
    });
  }

  return note;
}
