// src/lib/iros/intentMeta.ts
// Iros Intent Layer Meta
// 「会話のたびに I層を横に置いておく」ための軽量メタ構造

/* ========= I層レイヤー種別 ========= */
// weak_: I層の気配はあるが、材料が薄いとき
// 〜I3 : しっかり I層に触れているとき
export type IntentLayerKind = 'weak_I1' | 'I1' | 'I2' | 'I3';

/* ========= LLM から返してもらう intent 部分の JSON 例 =========
  meta: {
    q: { current: "Q2" },
    depth: { stage: "S3" },
    intent: {
      layer: "I2",                 // "weak_I1" | "I1" | "I2" | "I3" | "none"
      confidence: 0.82,            // 0〜1 / 未指定可
      reason: "～～と話しているため I2 と判断"
    }
  }
============================================================== */
export type LlmUnifiedIntentRaw = {
  layer?: IntentLayerKind | 'none' | null;
  confidence?: number | null;
  reason?: string | null;
};

/* ========= Iros 内部で扱う IntentMeta ========= */

export type IntentMeta = {
  /** null = 今回は I層として読む材料なし（無理に読まない） */
  layer: IntentLayerKind | null;
  /** 0〜1 の信頼度（なければ null） */
  confidence: number | null;
  /** LLM が付けた理由・メモ（UI にも出せる） */
  reason: string | null;
};

/** I層が「ちゃんと立っている」とみなすか */
export function hasSolidIntentLayer(intent: IntentMeta | null | undefined): boolean {
  if (!intent) return false;
  if (!intent.layer) return false;
  // weak_I1 は「気配のみ」扱い
  if (intent.layer === 'weak_I1') return false;
  return true;
}

/** weak_I1 も含めて「I層の気配があるか」 */
export function hasAnyIntentLayer(intent: IntentMeta | null | undefined): boolean {
  if (!intent) return false;
  return intent.layer != null;
}

/* ========= LLM からの raw を Iros 内部表現に正規化 ========= */

/**
 * LLM が返した meta.intent を Iros 内部の IntentMeta に変換する
 * - layer: "none" or null → null
 * - confidence: 範囲外はクリップ
 */
export function normalizeLlmIntent(raw: LlmUnifiedIntentRaw | null | undefined): IntentMeta {
  if (!raw) {
    return { layer: null, confidence: null, reason: null };
  }

  let layer: IntentLayerKind | null = null;
  if (raw.layer && raw.layer !== 'none') {
    // 型ガード的に一応チェック
    if (raw.layer === 'weak_I1' || raw.layer === 'I1' || raw.layer === 'I2' || raw.layer === 'I3') {
      layer = raw.layer;
    }
  }

  let confidence: number | null = null;
  if (typeof raw.confidence === 'number' && !Number.isNaN(raw.confidence)) {
    const v = raw.confidence;
    // 0〜1 にクリップ
    confidence = v < 0 ? 0 : v > 1 ? 1 : v;
  }

  const reason = raw.reason ?? null;

  return { layer, confidence, reason };
}

/* ========= Orchestrator からの利用ポイント想定 =========
 *
 * ① LLM からのレスポンスを受け取るとき：
 *
 *   const unified = llmResponse.meta?.unified ?? {};
 *   const intentRaw = unified.intent as LlmUnifiedIntentRaw | undefined;
 *   const intentMeta = normalizeLlmIntent(intentRaw);
 *
 * ② I層を「横に置いた状態」でモード決定するとき：
 *
 *   const isSolidI = hasSolidIntentLayer(intentMeta);
 *   const hasIHint = hasAnyIntentLayer(intentMeta);
 *
 *   // 例）goalKind 決定ロジックの一部
 *   if (isSolidI && depthStage.startsWith('S')) {
 *     // 表層は S3 でも、返答トーンは I層を意識したパートナー寄りにする…など
 *   }
 *
 * ③ UI で「I層の気配バッジ」を出したいとき：
 *
 *   if (hasAnyIntentLayer(intentMeta)) {
 *     // バッジ表示："I2" / "I1" など＋reason の tooltip
 *   }
 *
 * このファイルはあくまで「I層メタの定義と正規化」だけに絞っています。
 * Orchestrator 側では、既存の q/depth と同じように
 *   - resolve の中に intentMeta を差し込む
 *   - goalKind / priorityWeights を調整するときに参照する
 * という形で組み込んでください。
 */
