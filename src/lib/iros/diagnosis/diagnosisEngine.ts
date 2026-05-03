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

  const targetLabel =
    norm(input?.targetLabel) ||
    norm(debug.targetLabel) ||
    '自分';

  const nowShort = norm(debug.nowFlowShort);
  const futureShort = norm(debug.futureFlowShort);
  const delta = norm(debug.deltaSentence);
  const observed = pickObservedText(input, debug);

  const currentMaterial = norm((built.debug as any)?.observationResult);
  const pointMaterial = delta;
  const directionMaterial = norm((built.debug as any)?.awarenessText || delta);
  const messageMaterial = norm((built.debug as any)?.summaryText);

  // LLMに渡す素材は「このターンの診断素材」だけ。
  // 会話履歴の要約や、過去の流れの説明には寄せない。
  // 内部フローは、現実の状況・優先順位・意識の向きに置き換えて使う。
  const isDetailMode =
    input?.meta?.extra?.detailMode === true ||
    input?.meta?.detailMode === true;

  const prompt = isDetailMode
    ? `
あなたは ir診断を行う存在です。

以下の素材だけを使って、前回の診断内容をよりわかりやすく説明してください。
会話の流れ、過去のやり取り、ユーザーの背景推測は使わないでください。

【観測対象】
${targetLabel}

【ユーザー入力】
${observed || '（入力なし）'}

【現状の素材】
${currentMaterial}

【ポイントの素材】
${pointMaterial}

【意識の向かう先の素材】
${directionMaterial}

【メッセージの素材】
${messageMaterial}

【内部フロー素材】
今の流れ：${nowShort || '（なし）'}
向かう先：${futureShort || '（なし）'}
変化の要点：${delta || '（なし）'}

---

出力ルール：
・必ず次の5項目だけをこの順番で出力する
  🌀 観測対象：
  🧭 現状：
  🧩 ポイント：
  🌿 意識の向かう先：
  🌱 メッセージ：

・各行は「見出し：本文」を同一行で書く
・出力はちょうど5行にする
・観測対象は入力された対象をそのまま書く

・フェーズ、位相、深度、S1、R1、C1、I1、T1、Inner、Outer などの内部分類名や記号は出さない
・内部フロー素材をそのまま説明しない
・感情や深度の変化は、現実の状況、優先順位、意識の向きに置き換えて書く
・通常の意識の範囲で理解できる言葉にする
・会話の流れを読んでいるように書かない
・「これまで」「前から」「最近」「ずっと」など、履歴を見ているような言い方は使わない
・ユーザーの過去、性格、背景、相手の本心を推測しない

・「現状」は、今その人が現実でどんな状態に見えるかを書く
・「ポイント」は、今見落としやすい一点、または整えると変わりやすい一点を書く
・「意識の向かう先」は、気持ちや意識が現実の中でどこへ向かおうとしているかを書く
・「メッセージ」は、今の診断を受け取りやすい一文にする

・「悪いところ」「原因」「問題点」の指摘にしない
・抽象語を増やさず、日常語でわかりやすく書く
・「方向性」「次の段階」「実り」「基盤」「熱量」「意識・感情・行動」「収束」などの抽象語・構造語はできるだけ使わない
・使う場合は、「向かいたい先」「次にやること」「形になること」「足元の準備」「やりたい気持ち」「気持ちと行動」「整いやすくなる」のように言い換える
・一文を長くしすぎない
・比喩は使ってもよいが、難しい象徴表現にしない
・説明しすぎない
・質問で終わらない
・太文字（**）は使わない
・前置き、補足、箇条書き、空行は入れない
`
    : `
あなたは ir診断を行う存在です。

以下の素材だけを使って、ir診断の結果を日本語で出力してください。
会話の流れ、過去のやり取り、ユーザーの背景推測は使わないでください。

【観測対象】
${targetLabel}

【ユーザー入力】
${observed || '（入力なし）'}

【現状の素材】
${currentMaterial}

【ポイントの素材】
${pointMaterial}

【意識の向かう先の素材】
${directionMaterial}

【メッセージの素材】
${messageMaterial}

【内部フロー素材】
今の流れ：${nowShort || '（なし）'}
向かう先：${futureShort || '（なし）'}
変化の要点：${delta || '（なし）'}

---

出力ルール：
・必ず次の5項目だけをこの順番で出力する
  🌀 観測対象：
  🧭 現状：
  🧩 ポイント：
  🌿 意識の向かう先：
  🌱 メッセージ：

・各行は必ず「見出し：本文」を同一行で書く（改行しない）
・出力はちょうど5行にする
・観測対象は入力された対象をそのまま書く

・フェーズ、位相、深度、S1、R1、C1、I1、T1、Inner、Outer などの内部分類名や記号は出さない
・「1枚目」「2枚目」「カード」「引いた結果」「出た結果」など、占いを連想させる言い方は使わない
・番号づけや手順説明のような書き方をしない

・内部フロー素材をそのまま説明しない
・感情や深度の変化は、現実の状況、優先順位、意識の向きに置き換えて書く
・通常の意識の範囲で理解できる言葉にする
・会話の流れを読んでいるように書かない
・「これまで」「前から」「最近」「ずっと」など、履歴を見ているような言い方は使わない
・ユーザーの過去、性格、背景、相手の本心を推測しない

・「現状」は、今その人が現実でどんな状態に見えるかを書く
・「ポイント」は、今見落としやすい一点、または整えると変わりやすい一点を書く
・「意識の向かう先」は、気持ちや意識が現実の中でどこへ向かおうとしているかを書く
・「メッセージ」は、今の診断を受け取りやすい一文にする

・「悪いところ」「原因」「問題点」の指摘にしない
・感情は直接的な言葉（怒り・不安・恐怖など）を避け、
  「少し引っかかる」「気分が沈みがち」「やや焦りやすい」など、
  日常的でやわらかい表現に言い換える

・「成長」「進化」「希望」「歓喜」などの抽象キーワードは使わない
・「方向性」「次の段階」「実り」「基盤」「熱量」「意識・感情・行動」「収束」などの抽象語・構造語はできるだけ使わない
・使う場合は、「向かいたい先」「次にやること」「形になること」「足元の準備」「やりたい気持ち」「気持ちと行動」「整いやすくなる」のように言い換える
・難しい比喩に寄りすぎず、「一読でわかる」言葉にする
・専門的・詩的すぎる表現は避ける
・説明口調にしすぎない
・一文を長くしすぎない
・質問で終わらない

・太文字（**）は使わない
・前置き、補足、箇条書き、空行は入れない

---

出力例：
🌀 観測対象：今の自分
🧭 現状：やりたいことは見えてきていますが、まだ何から形にするかが少し定まりにくい状態です。
🧩 ポイント：考えを広げすぎると迷いやすいので、まず一つだけ決めることが大事です。
🌿 意識の向かう先：外側の反応より、自分が今進めたいことへ意識を戻す方向です。
🌱 メッセージ：今は「まずこれだけ進める」と決めることで、動きやすくなります。
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
