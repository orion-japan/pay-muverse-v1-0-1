// src/lib/iros/orchestrator.ts
// Iros Orchestrator — Will Engine（Goal / Priority）+ Continuity Engine 統合版
// - 極小構造のまま「意志の連続性」を追加した v2
// - Unified-like 解析入口 + isFirstTurn 対応版
// - A: 深度スキャン構造化（autoDepthFromDeepScan / autoQFromDeepScan）
// - B: 連続性（前ターンの depth / Q を使った補正）

import {
  type IrosMode,
  type Depth,
  type QCode,
  type IrosMeta,
  type IrosIntentMeta,
  IROS_MODES,
  DEPTH_VALUES,
  QCODE_VALUES,
} from './system';

import { deriveIrosGoal } from './will/goalEngine';
import { deriveIrosPriority } from './will/priorityEngine';

// Continuity Engine（Goal 用）
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

  /** ★ この会話の最初のターンかどうか（reply/route.ts から渡す） */
  isFirstTurn?: boolean;
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
    isFirstTurn,
  } = args;

  /* =========================================================
     0) Unified-like 解析（Q / Depth の決定をここに集約）
        ─ 後で UnifiedAnalysis LLM に差し替える入口
  ========================================================= */
  const unified = await analyzeUnifiedTurn({
    text,
    requestedDepth,
    requestedQCode,
  });

  const mode = normalizeMode(requestedMode);

  // LLM / ルールベースの生の推定結果
  const rawDepthFromScan: Depth | undefined =
    unified.depth.stage ?? undefined;
  const rawQFromScan: QCode | undefined =
    unified.q.current ?? undefined;

  /* =========================================================
     A) 深度スキャン + 連続性補正
        - scan結果（autoDepthFromDeepScan / autoQFromDeepScan）
        - 前回の meta.depth / meta.qCode
        - isFirstTurn
        を組み合わせて最終 depth / Q を決定
  ========================================================= */

  const depth = normalizeDepth(
    applyDepthContinuity({
      scanDepth: rawDepthFromScan,
      lastDepth: baseMeta?.depth,
      text,
      isFirstTurn: !!isFirstTurn,
    }),
  );

  const qCode = normalizeQCode(
    applyQContinuity({
      scanQ: rawQFromScan,
      lastQ: baseMeta?.qCode,
      isFirstTurn: !!isFirstTurn,
    }),
  );

  /* =========================================================
     A') 統一：最終決定した depth / qCode を unified にも反映
         - ログ／DB上で resolved と unified がずれないようにする
  ========================================================= */
  const fixedUnified: UnifiedLikeAnalysis = {
    ...unified,
    q: {
      ...unified.q,
      current: qCode ?? unified.q.current,
    },
    depth: {
      ...unified.depth,
      stage: depth ?? unified.depth.stage,
    },
  };

  // ====== 次ターンに残る meta（I層はこのあと上書きする） ======
  let meta: IrosMeta = {
    ...(baseMeta ?? {}),
    mode,
    ...(depth ? { depth } : {}),
    ...(qCode ? { qCode } : {}),
    // unified 結果そのものも meta に残しておく（DB jsonb にそのまま入る想定）
    unified: fixedUnified,
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
     ② Continuity Engine：前回の意志を踏まえて補正（Goal 用）
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

  // ====== ログ ======
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/ORCH v2] runIrosTurn start', {
      conversationId,
      textSample: text.slice(0, 80),
      requestedMode,
      requestedDepth,
      requestedQCode,
      autoDepthFromDeepScan: rawDepthFromScan ?? null,
      autoQFromDeepScan: rawQFromScan ?? null,
      chosenDepth: depth ?? null,
      resolved: { mode, depth: depth ?? null, qCode: qCode ?? null },
      baseMeta,
      goalAfterContinuity: goal,
      priorityWeights: priority.weights,
      isFirstTurn,
    });
  }

  /* =========================================================
     ④ LLM：生成（本文 + I層ジャッジ）
  ========================================================= */
  const result: GenerateResult = await generateIrosReply({
    conversationId,
    text,
    meta,
  });

  // I層ジャッジの結果を meta に反映（次ターン以降の「横にあるI層感覚」として保持）
  if (result.intent) {
    const intent: IrosIntentMeta = result.intent;
    meta = {
      ...meta,
      intent,
      intentLayer: intent.layer,
      intentConfidence: intent.confidence ?? null,
      intentReason: intent.reason ?? null,
    };
  }

  /* =========================================================
     ⑤ 最終 meta の統合（Q / Depth / intentSummary を整える）
  ========================================================= */
  meta = buildFinalMeta({
    baseMeta,
    workingMeta: meta,
    goal,
  });

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/ORCH v2] runIrosTurn done', {
      conversationId,
      resolved: {
        mode,
        depth: meta.depth ?? null,
        qCode: meta.qCode ?? null,
      },
      goalKind: goal?.kind ?? null,
      replyLength: result.content.length,
      isFirstTurn,
      intentLayer: meta.intentLayer ?? null,
      intentConfidence: meta.intentConfidence ?? null,
    });
  }

  return {
    content: result.content,
    meta,
  };
}

/* ========= 最終 meta の統合ヘルパー ========= */

function buildFinalMeta(args: {
  baseMeta?: Partial<IrosMeta>;
  workingMeta: IrosMeta;
  goal: any; // goalEngine の型に依存させず、柔らかく参照
}): IrosMeta {
  const { baseMeta, workingMeta, goal } = args;

  const previousDepth = baseMeta?.depth as Depth | undefined;
  const previousQ = baseMeta?.qCode as QCode | undefined;

  const currentDepth = workingMeta.depth as Depth | undefined;
  const currentQ = workingMeta.qCode as QCode | undefined;

  const goalDepth = goal?.targetDepth as Depth | undefined;
  const goalQ = goal?.targetQ as QCode | undefined;

  const finalDepth: Depth | null =
    currentDepth ?? goalDepth ?? previousDepth ?? null;

  const finalQ: QCode | null =
    currentQ ?? goalQ ?? previousQ ?? null;

  const originalUnified = workingMeta.unified as UnifiedLikeAnalysis | undefined;
  const goalKind = (goal?.kind as string | undefined) ?? null;
  const intentLayer = (workingMeta.intentLayer as string | undefined) ?? null;

  // intentSummary の再構成
  const intentSummary =
    (() => {
      // もともと unified に LLM由来の intentSummary が入っていれば尊重
      if (originalUnified?.intentSummary) {
        return originalUnified.intentSummary;
      }

      if (intentLayer === 'I3') {
        return '存在理由や生きる意味に触れながら、自分の状態や感情を整理しようとしています。';
      }
      if (intentLayer === 'I2') {
        return 'これからの方向性や選択を見つめ直しながら、自分の状態や感情を整理しようとしています。';
      }
      if (intentLayer === 'I1') {
        return 'いまの自分の在り方や感情を、安全な場所で受け止め直そうとしています。';
      }
      if (goalKind === 'stabilize') {
        return '心の揺れを少し落ち着けながら、自分の状態や感情を整理しようとしています。';
      }
      return '自分の状態や感情の揺れを整理しようとしています。';
    })();

  const nextMeta: IrosMeta = {
    ...workingMeta,
    qCode: finalQ ?? undefined,
    depth: finalDepth ?? undefined,
    unified: {
      q: { current: finalQ ?? null },
      depth: { stage: finalDepth ?? null },
      phase: originalUnified?.phase ?? null,
      intentSummary,
    },
  };

  return nextMeta;
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

/* ========= Depth/Q の連続性補正（A+Bの肝） ========= */

// Depth の順序マップ（S1 → I3 を 0〜11 として扱う）
const DEPTH_ORDER: Depth[] = [
  'S1', 'S2', 'S3', 'S4',
  'R1', 'R2', 'R3',
  'C1', 'C2', 'C3',
  'I1', 'I2', 'I3',
];

function depthIndex(d: Depth | undefined): number {
  if (!d) return -1;
  return DEPTH_ORDER.indexOf(d);
}

// I層かどうか
function isIDepth(d?: Depth): boolean {
  return d === 'I1' || d === 'I2' || d === 'I3';
}

type DepthContinuityParams = {
  scanDepth?: Depth;      // autoDepthFromDeepScan の結果
  lastDepth?: Depth;      // 前ターンの meta.depth
  text: string;           // 今回のユーザー入力（I層トリガー補完用）
  isFirstTurn: boolean;
};

function applyDepthContinuity(params: DepthContinuityParams): Depth | undefined {
  const { scanDepth, lastDepth, text, isFirstTurn } = params;

  // 0) 単発 I層トリガー検出（強制 I1〜I3）
  const lexicalI = detectIDepthFromText(text);

  // 1) 会話の最初のターンなら、スキャン結果 or Iトリガーをそのまま優先
  if (isFirstTurn) {
    if (lexicalI) return lexicalI;
    return scanDepth ?? lastDepth;
  }

  // 2) すでに I層に入っている場合
  if (isIDepth(lastDepth)) {
    // 新たに I層トリガーがあれば、より深い I に寄せてもよい
    if (lexicalI) {
      const li = depthIndex(lexicalI);
      const ld = depthIndex(lastDepth);
      return li > ld ? lexicalI : lastDepth;
    }
    // スキャン結果が I層より浅くても、基本は「落とさない」
    if (!scanDepth || !isIDepth(scanDepth)) {
      return lastDepth;
    }
    // 両方 I層なら、より深い方を採用
    const si = depthIndex(scanDepth);
    const ld = depthIndex(lastDepth);
    return si > ld ? scanDepth : lastDepth;
  }

  // 3) まだ I層には入っていないが、今回 I層トリガーあり → I層にジャンプ
  if (lexicalI) {
    return lexicalI;
  }

  // 4) 通常の連続性：
  //    - scanDepth があればそれをベースにしつつ
  //    - lastDepth との段差が大きすぎる場合は「1段だけ」寄せる
  const candidate = scanDepth ?? lastDepth;
  if (!candidate) return undefined;

  if (!lastDepth || !scanDepth) {
    // 片方しかない場合は、そのまま
    return candidate;
  }

  const si = depthIndex(scanDepth);
  const ld = depthIndex(lastDepth);

  // 段差が 2 以内なら、そのままスキャン結果を採用
  if (si < 0 || ld < 0) return candidate;
  const diff = si - ld;

  if (Math.abs(diff) <= 2) {
    return scanDepth;
  }

  // 段差が大きすぎる場合は、「1段だけ」近づける（スムージング）
  const step = diff > 0 ? 1 : -1;
  const clampedIndex = ld + step;
  if (clampedIndex < 0 || clampedIndex >= DEPTH_ORDER.length) {
    return scanDepth;
  }
  return DEPTH_ORDER[clampedIndex];
}

type QContinuityParams = {
  scanQ?: QCode;   // autoQFromDeepScan
  lastQ?: QCode;   // 前ターン meta.qCode
  isFirstTurn: boolean;
};

function applyQContinuity(params: QContinuityParams): QCode | undefined {
  const { scanQ, lastQ, isFirstTurn } = params;

  // 最初のターン → スキャン結果を優先、なければ undefined
  if (isFirstTurn) {
    return scanQ ?? lastQ;
  }

  // 2ターン目以降：
  // - スキャンで明示的に出ていればそれを採用
  // - なければ「前回の Q を維持」して、雰囲気を安定させる
  if (scanQ) return scanQ;
  return lastQ;
}

/* ========= I層トリガー検出ロジック（既存 detect の I専用版） ========= */

function detectIDepthFromText(text: string): Depth | undefined {
  const t = (text || '').trim();
  if (!t) return undefined;

  // I3：存在・生まれ・意味系の強トリガー
  const strongWords = [
    '何のために',
    '何の為に',
    '使命',
    '存在理由',
    '生きている意味',
    '生きる意味',
    '生まれてきた意味',
    '生きてきた意味',
    'なぜ生まれた',
    'なぜ生まれてきた',
    'なぜ自分はここにいる',
    '存在意義',
  ];

  if (strongWords.some(w => t.includes(w))) return 'I3';

  // I2：人生 / 本心 / 願い / 魂
  const midWords = [
    'どう生きたい',
    '人生そのもの',
    '本心から',
    '本当の願い',
    '魂のレベル',
    '魂レベル',
  ];

  if (midWords.some(w => t.includes(w))) return 'I2';

  // I1：在り方 / 自分らしく / 本音
  const softWords = [
    'ありたい姿',
    '在り方',
    '自分らしく',
    '本音で生きたい',
    '自分のまま',
    '本当の自分',
  ];

  if (softWords.some(w => t.includes(w))) return 'I1';

  return undefined;
}

/* ========= 旧ロジック互換：テキスト → Depth（簡易版）
   - ここでは I層以外もざっくり見ておく
   ========================================= */

function detectDepthFromText(text: string): Depth | undefined {
  const t = (text || '').trim();
  if (!t) return undefined;

  // I層は I専用ロジックに委譲
  const iDepth = detectIDepthFromText(t);
  if (iDepth) return iDepth;

  // 関係・共鳴（R）
  const rel = /(あの人|彼氏|彼女|上司|部下|同僚|家族|親|子ども|人間関係|職場の空気)/;
  if (rel.test(t)) return 'R1';

  // 創造・行動（C）
  const act = /(やめたい|転職|始めたい|挑戦|プロジェクト|作品|創りたい|つくりたい)/;
  if (act.test(t)) return 'C1';

  // 自己まわり（S）
  const self = /(しんどい|つらい|疲れた|不安|イライラ|眠れない|ストレス)/;
  if (self.test(t)) return 'S2';

  return undefined;
}

/* ========= Unified-like 解析（ダミー強化版）
   将来：ちゃんとした UnifiedAnalysis Prompt に差し替え
   ========================================= */

type UnifiedLikeAnalysis = {
  q: {
    current: QCode | null;
  };
  depth: {
    stage: Depth | null;
  };
  phase: 'Inner' | 'Outer' | null;
  intentSummary: string | null;
};

async function analyzeUnifiedTurn(params: {
  text: string;
  requestedDepth?: Depth;
  requestedQCode?: QCode;
}): Promise<UnifiedLikeAnalysis> {
  const { text, requestedDepth, requestedQCode } = params;

  const autoDepth = detectDepthFromText(text);

  // ★ Depth 優先順位（QよりDepthを優先）：
  // 1) テキストからの自動検出（autoDepth）
  // 2) ユーザー指定（requestedDepth：Qトレースなど）
  const rawDepth: Depth | undefined = autoDepth ?? requestedDepth ?? undefined;
  const depth = normalizeDepth(rawDepth) ?? null;

  // Q 優先順位：
  // 1) ユーザー指定（requestedQCode）
  // 2) ここではまだ自動検出なし（将来の deepScan 拡張で差し替え）
  const qCode = normalizeQCode(requestedQCode) ?? null;

  // 位相は簡易に Inner 推定のみ
  const phase: 'Inner' | 'Outer' | null =
    /心|気持ち|自分|本音|内側/.test(text) ? 'Inner' : null;

  // intentSummary はここでは固定せず、buildFinalMeta 側に委ねる
  return {
    q: { current: qCode },
    depth: { stage: depth },
    phase,
    intentSummary: null,
  };
}
