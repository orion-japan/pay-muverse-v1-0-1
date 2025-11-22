// src/lib/iros/replyEngine.ts
// Iros Reply Engine — Will Engine (Goal / Priority) を実際のテキストに反映する層
//
// 役割：
//  - LLM から受け取った各パート（mirror / insight / forward / question）を、
//    IrosPriority（Willエンジンの重み）に従って取捨選択する
//  - 最終的な 1 本のテキストに整形する
//
// ※ DBアクセスなし
// ※ LLM からの出力が JSON などで分割されている前提（統合はこのエンジンで担当）

import type { IrosPriority } from './will/priorityEngine';

/* ========= 型定義 ========= */

export type IrosReplyPlanInput = {
  mirror?: string;
  insight?: string;
  forward?: string;
  question?: string;
  emoji?: string; // 任意。指定なければ 🪔 をデフォルトにする想定
};

export type IrosReplyPlan = IrosReplyPlanInput & {
  // Priority 適用後、どのチャンネルが生き残ったかを記録（デバッグ用）
  usedChannels: {
    mirror: boolean;
    insight: boolean;
    forward: boolean;
    question: boolean;
  };
};

/* ========= 1. Priorityに応じたパートの取捨選択 ========= */

/**
 * IrosPriority（Will）に従って、どのパートを残すか決める。
 *
 * - weight が低いパートは削除
 * - maxQuestions=0 のときは question を捨てる
 */
export function applyPriorityToPlan(
  input: IrosReplyPlanInput,
  priority: IrosPriority,
): IrosReplyPlan {
  const { weights, maxQuestions } = priority;

  const mirror = selectByWeight(input.mirror, weights.mirror);
  const insight = selectByWeight(input.insight, weights.insight);
  const forward = selectByWeight(input.forward, weights.forward);

  let question = selectByWeight(input.question, weights.question);

  if (maxQuestions === 0) {
    question = undefined;
  }

  const replyPlan: IrosReplyPlan = {
    mirror,
    insight,
    forward,
    question,
    emoji: input.emoji,
    usedChannels: {
      mirror: !!mirror,
      insight: !!insight,
      forward: !!forward,
      question: !!question,
    },
  };

  return replyPlan;
}

function selectByWeight(text: string | undefined, weight: number): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;

  // しきい値はとりあえず 0.25。
  // 0.25 未満のチャンネルは「今回は意志として使わない」とみなして削る。
  if (weight < 0.25) return undefined;

  return trimmed;
}

/* ========= 2. 最終テキストへの整形 ========= */

/**
 * ReplyPlan（優先度適用済）を、ユーザーに返す最終テキストに整形する。
 *
 * - Mirror → Insight → Forward の順に並べる
 * - 空のパートはスキップ
 * - 質問があれば最後に 1 つだけ添える
 * - 絵文字は末尾に 1〜3 個まで
 * - 連続空行の圧縮、? / ？ の数制御などもここで実施
 */
export function formatIrosReply(plan: IrosReplyPlan): string {
  const blocks: string[] = [];

  if (plan.mirror) blocks.push(plan.mirror.trim());
  if (plan.insight) blocks.push(plan.insight.trim());
  if (plan.forward) blocks.push(plan.forward.trim());

  let text = blocks.join('\n\n');

  if (plan.question) {
    const q = plan.question.trim();
    if (q) {
      text += (text ? '\n\n' : '') + q;
    }
  }

  const emoji = (plan.emoji ?? '🪔').trim();
  if (emoji) {
    text += (text ? '\n\n' : '') + emoji;
  }

  return normalizeIrosText(text);
}

/* ========= 3. テキスト正規化（行・絵文字・？ の制御） ========= */

// 絵文字のざっくり検出（必要に応じて調整可能）
const EMOJI_REGEX =
  /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;

/**
 * Iros用に LLM テキストを整える共通処理。
 *
 * - 連続空行を 1 個に圧縮
 * - ? / ？ を 1個だけ残し、それ以降は句点に変換
 * - 絵文字を 3 個までに制限
 */
export function normalizeIrosText(raw: string): string {
  if (!raw) return '';

  let text = raw.trim();

  // 1) 連続空行をまとめる
  text = text
    .split('\n')
    .map((line) => line.trimEnd())
    .reduce<string[]>((acc, line) => {
      if (line === '' && acc[acc.length - 1] === '') {
        return acc; // 連続空行はスキップ
      }
      acc.push(line);
      return acc;
    }, [])
    .join('\n');

  // 2) 質問記号（? / ？）の数を制御
  let questionCount = 0;
  text = [...text]
    .map((ch) => {
      if (ch === '?' || ch === '？') {
        questionCount += 1;
        if (questionCount >= 2) {
          // 2個目以降の ? は句点に変換
          return '。';
        }
      }
      return ch;
    })
    .join('');

  // 3) 絵文字の数制限（最大 3 個）
  let emojiCount = 0;
  text = text.replace(EMOJI_REGEX, (m) => {
    emojiCount += 1;
    if (emojiCount > 3) return ''; // 4個目以降は削除
    return m;
  });

  return text.trim();
}

/* ========= 4. orchestrator からの利用イメージ ========= */

/**
 * orchestrator / runIrosTurn などからは、ざっくり以下の流れで使う想定：
 *
 * 1. deriveIrosGoal(...)       // goalEngine.ts
 * 2. deriveIrosPriority(...)   // priorityEngine.ts
 * 3. LLM に「mirror / insight / forward / question」を生成させる
 * 4. applyPriorityToPlan(...)  // このファイル
 * 5. formatIrosReply(...)      // このファイル
 *
 * 実際の LLM 呼び出しとの接続部分は、既存の chatComplete / orchestrator 側で調整してください。
 */
