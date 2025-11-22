// src/lib/iros/orchestrator.ts
// Iros Orchestrator — Will Engine（Goal / Priority）+ Continuity Engine 統合版
// - 極小構造のまま「意志の連続性」を追加した v2

import {
  type IrosMode,
  type Depth,
  type QCode,
  type IrosMeta,
  IROS_MODES,
  DEPTH_VALUES,
  QCODE_VALUES,
} from './system';

import { deriveIrosGoal } from './will/goalEngine';
import { deriveIrosPriority } from './will/priorityEngine';

// Continuity Engine
import {
  applyGoalContinuity,
  type ContinuityContext,
} from './will/continuityEngine';

import {
  generateIrosReply,
  type GenerateResult,
} from './generate';

// ==== Orchestrator に渡す引数 ==== //
export type IrosOrchestratorArgs = {
  conversationId?: string;
  text: string;

  requestedMode?: IrosMode;
  requestedDepth?: Depth;
  requestedQCode?: QCode;

  baseMeta?: Partial<IrosMeta>;
};

// ==== Orchestrator から返す結果 ==== //
export type IrosOrchestratorResult = {
  content: string;
  meta: IrosMeta;
};

export async function runIrosTurn(
  args: IrosOrchestratorArgs,
): Promise<IrosOrchestratorResult> {
  const {
    conversationId,
    text,
    requestedMode,
    requestedDepth,
    requestedQCode,
    baseMeta,
  } = args;

  const mode = normalizeMode(requestedMode);

  // 自動 I 層検出
  const autoDepth = detectDepthFromText(text);

  const rawDepth: Depth | undefined = (() => {
    if (autoDepth && autoDepth.startsWith('I')) return autoDepth;
    return requestedDepth ?? autoDepth;
  })();

  const depth = normalizeDepth(rawDepth);
  const qCode = normalizeQCode(requestedQCode);

  // 次ターンに残る meta
  const meta: IrosMeta = {
    ...(baseMeta ?? {}),
    mode,
    ...(depth ? { depth } : {}),
    ...(qCode ? { qCode } : {}),
  } as IrosMeta;

  /* =========================================================
     ① Goal Engine：今回の "意志" を生成
  ========================================================= */
  let goal = deriveIrosGoal({
    userText: text,
    lastDepth: baseMeta?.depth,
    lastQ: baseMeta?.qCode,
    requestedDepth,
    requestedQCode,
  });

  /* =========================================================
     ② Continuity Engine：前回の意志を踏まえて補正
        → ここで「生きた流れ」になる
  ========================================================= */
  const continuity: ContinuityContext = {
    lastDepth: baseMeta?.depth,
    lastQ: baseMeta?.qCode,
    userText: text,
  };

  goal = applyGoalContinuity(goal, continuity);

  /* =========================================================
     ③ Priority Engine：Goal の意志に基づき重み計算
  ========================================================= */
  const priority = deriveIrosPriority({
    goal,
    mode,
    depth,
    qCode,
  });

  // ====== ログ（開発時のみ） ======
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('[IROS/ORCH v2] runIrosTurn start', {
      conversationId,
      textSample: text.slice(0, 80),
      requestedMode,
      requestedDepth,
      requestedQCode,
      autoDepth,
      chosenDepth: depth,
      resolved: { mode, depth, qCode },
      baseMeta,
      goalAfterContinuity: goal,
      priorityWeights: priority.weights,
    });
  }

  /* =========================================================
     ④ LLM：生成（従来と同じ）
  ========================================================= */
  const result: GenerateResult = await generateIrosReply({
    conversationId,
    text,
    meta,
  });

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('[IROS/ORCH v2] runIrosTurn done', {
      conversationId,
      resolved: { mode, depth, qCode },
      goalKind: goal.kind,
      replyLength: result.content.length,
    });
  }

  return {
    content: result.content,
    meta,
  };
}

/* ========= 最小バリデーション ========= */

function normalizeMode(mode?: IrosMode): IrosMode {
  if (!mode) return 'mirror';
  return IROS_MODES.includes(mode) ? mode : 'mirror';
}

function normalizeDepth(depth?: Depth): Depth | undefined {
  if (!depth) return undefined;
  return DEPTH_VALUES.includes(depth) ? depth : undefined;
}

function normalizeQCode(qCode?: QCode): QCode | undefined {
  if (!qCode) return undefined;
  return QCODE_VALUES.includes(qCode) ? qCode : undefined;
}

/* ========= I層トリガー検出ロジック（極小） ========= */

function detectDepthFromText(text: string): Depth | undefined {
  const t = (text || '').trim();
  if (!t) return undefined;

  const strong = /(何のために|使命|存在理由|生きている意味)/;
  if (strong.test(t)) return 'I3';

  const mid = /(どう生きたい|人生|本心|願い)/;
  if (mid.test(t)) return 'I2';

  const soft = /(ありたい姿|望み|在り方)/;
  if (soft.test(t)) return 'I1';

  return undefined;
}
