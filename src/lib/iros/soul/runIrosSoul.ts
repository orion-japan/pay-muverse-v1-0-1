// src/lib/iros/soul/runIrosSoul.ts
// Iros 魂レイヤー本体呼び出し
// - Silent Advisor として JSON だけを返す LLM を叩き、IrosSoulNote にパースする

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
  debugLog?: (label: string, payload: any) => void;
};

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
    const messages = buildIrosSoulMessages(
      input,
    ) as ChatCompletionMessageParam[];

    if (process.env.DEBUG_IROS_SOUL === '1') {
      console.log('[IROS/Soul] request', { input });
    }
    debugLog?.('[IROS/Soul] request', { input });

    const res = await client.chat.completions.create({
      model: IROS_SOUL_MODEL,
      messages,
      temperature: 0,
    });

    const raw =
      res.choices?.[0]?.message?.content?.toString().trim() ?? '';

    if (process.env.DEBUG_IROS_SOUL === '1') {
      console.log('[IROS/Soul] raw', raw);
    }
    debugLog?.('[IROS/Soul] raw', raw);

    if (!raw) return null;

    // まず素直に JSON.parse を試す
    let parsed: any;
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

    if (!parsed || typeof parsed !== 'object') return null;

    const note = normalizeSoulNote(parsed);
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
 */
function normalizeSoulNote(raw: any): IrosSoulNote | null {
  if (!raw || typeof raw !== 'object') return null;

  const core_need =
    typeof raw.core_need === 'string' && raw.core_need.trim().length > 0
      ? raw.core_need.trim()
      : null;

  const tone =
    raw.tone_hint === 'soft' ||
    raw.tone_hint === 'light' ||
    raw.tone_hint === 'firm' ||
    raw.tone_hint === 'minimal'
      ? (raw.tone_hint as IrosSoulNote['tone_hint'])
      : 'soft';

  const risk_flags: string[] = Array.isArray(raw.risk_flags)
    ? raw.risk_flags
        .map((v: any) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v: string) => v.length > 0)
    : [];

  if (!core_need) {
    // core_need が無い場合は魂ノートとして扱わない
    return null;
  }

  const note: IrosSoulNote = {
    core_need,
    risk_flags,
    tone_hint: tone,
  };

  if (
    typeof raw.step_phrase === 'string' &&
    raw.step_phrase.trim().length > 0
  ) {
    note.step_phrase = raw.step_phrase.trim();
  }

  if (
    typeof raw.soul_sentence === 'string' &&
    raw.soul_sentence.trim().length > 0
  ) {
    note.soul_sentence = raw.soul_sentence.trim();
  }

  if (typeof raw.notes === 'string' && raw.notes.trim().length > 0) {
    note.notes = raw.notes.trim();
  }

  return note;
}
