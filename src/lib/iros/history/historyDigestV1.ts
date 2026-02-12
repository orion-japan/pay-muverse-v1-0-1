// src/lib/iros/history/historyDigestV1.ts
// iros — HistoryDigest v1 (single place builder + injector)

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export type Phase = 'Inner' | 'Outer';

export type HistoryDigestV1 = {
  anchor: { key: string; phrase: string };
  state: { q: QCode; depth: string; phase: Phase };
  topic: { situationTopic: string; situationSummary: string };
  continuity: {
    last_user_core: string;
    last_assistant_core: string;
    repeat_signal: boolean;
  };
};

export type BuildHistoryDigestV1Args = {
  // anchor priority: fixedNorth > metaForSave.intent_anchor_key > memoryState.intentAnchor
  fixedNorth?: { key: string; phrase?: string } | null;

  metaAnchorKey?: string | null; // metaForSave.intent_anchor_key など
  memoryAnchorKey?: string | null; // memoryState.intentAnchor など

  qPrimary: QCode;
  depthStage: string;
  phase: Phase;

  situationTopic: string;
  situationSummary: string;

  lastUserCore: string;
  lastAssistantCore: string;
  repeatSignal: boolean;
};

function pickAnchor(args: BuildHistoryDigestV1Args): { key: string; phrase: string } {
  const key = args.fixedNorth?.key || args.metaAnchorKey || args.memoryAnchorKey || 'SUN';

  // phrase は固定でOK（v1 なのでブレさせない）
  const phrase = args.fixedNorth?.phrase || '成長 / 進化 / 希望 / 歓喜';
  return { key, phrase };
}

export function buildHistoryDigestV1(args: BuildHistoryDigestV1Args): HistoryDigestV1 {
  return {
    anchor: pickAnchor(args),
    state: { q: args.qPrimary, depth: args.depthStage, phase: args.phase },
    topic: { situationTopic: args.situationTopic, situationSummary: args.situationSummary },
    continuity: {
      last_user_core: args.lastUserCore,
      last_assistant_core: args.lastAssistantCore,
      repeat_signal: args.repeatSignal,
    },
  };
}

export function injectHistoryDigestV1(params: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  digest: HistoryDigestV1;
}) {
  const digestText = '[HISTORY_DIGEST_V1]\n' + JSON.stringify(params.digest);

  // systemPrompt の次に差し込む（role:system の2本目）
  // 既に入っている場合は二重注入しない
  const hasAlready = params.messages.some(
    (m) => m.role === 'system' && m.content.startsWith('[HISTORY_DIGEST_V1]'),
  );
  if (hasAlready) return { messages: params.messages, digestChars: digestText.length, injected: false };

  const out = [...params.messages];
  // 先頭が systemPrompt 前提。安全に「最初のsystemの直後」へ。
  const firstSystemIdx = out.findIndex((m) => m.role === 'system');
  const insertAt = firstSystemIdx >= 0 ? firstSystemIdx + 1 : 0;
  out.splice(insertAt, 0, { role: 'system', content: digestText });

  return { messages: out, digestChars: digestText.length, injected: true };
}
