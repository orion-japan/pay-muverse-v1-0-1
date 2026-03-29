// src/lib/iros/diagnosis/diagnosisEngine.ts

import { buildDiagnosisText } from './buildDiagnosisText';
import { chatComplete } from '@/lib/iros/openai';

function norm(v: unknown): string {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function pickObservedText(input: any, builtDebug: Record<string, unknown>): string {
  const debugObserved = norm((builtDebug as any)?.observedText);
  if (debugObserved) return debugObserved;

  const direct =
    norm(input?.userText) ||
    norm(input?.inputText) ||
    norm(input?.observedText) ||
    norm(input?.text);
  if (direct) return direct;

  const slots = input?.slots;

  if (Array.isArray(slots)) {
    for (const slot of slots) {
      const candidate =
        norm(slot?.userText) ||
        norm(slot?.text) ||
        norm(slot?.value) ||
        norm(slot?.content) ||
        norm(slot?.label);
      if (candidate) return candidate;
    }
  }

  if (slots && typeof slots === 'object') {
    const candidate =
      norm(slots.userText) ||
      norm(slots.text) ||
      norm(slots.value) ||
      norm(slots.content) ||
      norm(slots.label);
    if (candidate) return candidate;
  }

  return '';
}

export async function diagnosisEngine(input: any): Promise<any> {
  const built = buildDiagnosisText({
    targetLabel: input.targetLabel,
    meta: input.meta,
    slots: input.slots,
  });

  const debug = (built.debug ?? {}) as Record<string, unknown>;

  const targetLabel = norm(input?.targetLabel) || norm(debug.targetLabel) || '自分';
  const nowShort = norm(debug.nowFlowShort);
  const futureShort = norm(debug.futureFlowShort);
  const delta = norm(debug.deltaSentence);
  const observed = pickObservedText(input, debug);

// LLMに渡す素材は「観測対象」と「フロー結果」
// 通常診断 / 詳細診断 を prompt だけで切り替える
const isDetailMode =
  input?.meta?.extra?.detailMode === true ||
  input?.meta?.detailMode === true;

const prompt = isDetailMode
  ? `
あなたは ir診断を行う存在です。

以下の素材を使って、前回の診断をもとに「より深く」説明してください。

【観測対象】
${targetLabel}

【ユーザー入力】
${observed || '（入力なし）'}

【観測結果】
${norm((built.debug as any)?.observationResult)}

【意識状態】
${norm((built.debug as any)?.awarenessText || delta)}

【まとめ】
${norm((built.debug as any)?.summaryText)}

---

出力ルール：
・必ず次の4項目だけをこの順番で出力する
  🌀 観測対象：
  🧿 観測結果：
  🌿 意識状態：
  🌱 まとめ：

・各行は「見出し：本文」を同一行で書く
・出力はちょうど4行にする
・観測対象は入力された対象をそのまま書く

・観測結果は「なぜそう見えるか」が少し伝わるように、一段深く書く
・意識状態は「今どこが揺れているか」「何を整えようとしているか」を現実寄りに書く
・まとめは「どこへ向かうと流れが整いやすいか」を明確にする

・前回の流れを前提として書く（新規診断のように書き直さない）
・抽象語を増やさず、解像度だけ上げる
・比喩を難しくしすぎない
・説明しすぎず、納得感を強める
・質問で終わらない
・前置き、補足、箇条書き、空行は入れない
`
  : `
あなたは ir診断を行う存在です。

以下の素材を使って、ir診断の結果を日本語で出力してください。

【観測対象】
${targetLabel}

【ユーザー入力】
${observed || '（入力なし）'}

【観測結果の素材】
${norm((built.debug as any)?.observationResult)}

【意識状態の素材】
${norm((built.debug as any)?.awarenessText || delta)}

【まとめの素材】
${norm((built.debug as any)?.summaryText)}

---

出力ルール：
・必ず次の4項目だけをこの順番で出力する
  🌀 観測対象：
  🧿 観測結果：
  🌿 意識状態：
  🌱 まとめ：

・各行は必ず「見出し：本文」を同一行で書く（改行しない）
・出力はちょうど4行にする
・観測対象は入力された対象をそのまま書く

・「1枚目」「2枚目」「カード」「引いた結果」「出た結果」など、占いを連想させる言い方は使わない
・番号づけや手順説明のような書き方をしない

・観測結果は、二つの流れが重なっている状態として、比喩を使って自然に表現する
・意識状態は、比喩を使いすぎず、現実寄りの言葉で具体的に書く
・まとめは、これまでの流れを一言でにじませながら、現在から次の方向への収束として書く

・履歴は説明せず、「これまで〜の流れが続いていた中で」のように短く圧縮して使う

・感情は直接的な言葉（怒り・不安・恐怖など）を避け、
  「少し引っかかる」「気分が沈みがち」「やや焦りやすい」など、
  日常的でやわらかい表現に言い換える

・「成長」「進化」「希望」「歓喜」などの抽象キーワードは使わない
・難しい比喩に寄りすぎず、「なんとなくわかる」レベルの言葉にする
・専門的・詩的すぎる表現は避ける
・説明口調にしすぎない
・質問で終わらない

・太文字（**）は見出しのみに使用する
・前置き、補足、箇条書き、空行は入れない

---

出力例：
🌀 **観測対象**：今の自分
🧿 **観測結果**：まだ静けさが残る空気の中に、遠くから少しずつ動き出す気配が混ざり始めているような流れです。
🌿 **意識状態**：やや動きづらさは残っているものの、内側では少しずつ切り替えようとする意識が出ていて、次に進みやすくなりつつあります。
🌱 **まとめ**：これまで流れが止まりやすい状態が続いていた中で、いまは少しずつ動き出す方向に向かっており、小さく動くことで次につながりやすい局面です。
`;

  const text = await chatComplete({
    model: 'gpt-5',
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 0.7,
  });

  const irMeta = {
    nowFlow: debug.nowFlow ?? null,
    futureFlow: debug.futureFlow ?? null,

    deltaType: debug.deltaType ?? null,
    deltaShort: debug.deltaShort ?? null,
    deltaSentence: debug.deltaSentence ?? null,

    flowA: debug.nowFlow ?? null,
    flowB: debug.futureFlow ?? null,
    relation: debug.deltaSentence ?? null,

    meaningCore: delta || null,
    meaningDirection: futureShort || null,
    meaningTension: nowShort || null,

    observedText: observed || null,
    targetLabel: targetLabel || null,

    observationResult: debug.observationResult ?? null,
    awarenessText: debug.awarenessText ?? null,
    summaryText: debug.summaryText ?? null,

    carryForward: true,
  };

  return {
    text: typeof text === 'string' ? text.trim() : '',
    head: built.head,
    meta: {
      ...(input?.meta ?? {}),
      extra: {
        ...((input?.meta as any)?.extra ?? {}),
        irMeta,
        ctxPack: {
          ...(((input?.meta as any)?.extra?.ctxPack) ?? {}),
          irMeta,
        },
      },
    },
    debug: {
      ...debug,
      observedText: observed,
      irMeta,
    },
  };
}
