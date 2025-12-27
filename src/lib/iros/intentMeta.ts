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

/* ============================================================
 * North Star (SUN) / Anchor Meta
 * - IntentMeta（I層）とは別軸で「固定 / 候補 / リセット」を管理する
 * - “ポジティブ方向が必要” はここで受ける：
 *     - fixed(anchored) は「選択・確定・反復」等の証拠が条件
 *     - それ以外は candidate（候補）として保持
 * ============================================================ */

export type NorthStarStatus = 'none' | 'candidate' | 'anchored' | 'released';

/** 北極星のイベント（会話内での操作ログ用途） */
export type NorthStarEventType = 'none' | 'set_candidate' | 'anchor_set' | 'reset' | 'hold_candidate';

/** 行動的証拠（コミット条件の材料）。 positivity だけでは anchored にしない */
export type NorthStarEvidenceType = 'utterance' | 'choice' | 'action';

export type NorthStarEvidence = {
  type: NorthStarEvidenceType;
  strength: number; // 0..1
  ref: string; // messageId / choiceId / action key
  at: string; // ISO
};

export type NorthStarMeta = {
  status: NorthStarStatus;
  /** 候補 or 固定されている北極星テキスト（SUN方向の言語化） */
  text: string | null;
  /** 0..1（anchored は必ず evidence に支えられる） */
  confidence: number | null;
  /** 直近の操作/決定理由（UI tooltip でもOK） */
  reason: string | null;
  /** 最終更新 */
  updatedAt: string | null;
  /** 証拠（bounded） */
  evidence: NorthStarEvidence[];
  /** 最後のイベント（デバッグ/ログ/学習用） */
  event: NorthStarEventType;
};

/** LLM から返ってくる可能性がある raw（将来用。今なくてもOK） */
export type LlmNorthStarRaw = {
  status?: NorthStarStatus | null; // none/candidate/anchored/released
  text?: string | null;
  confidence?: number | null;
  reason?: string | null;
};

/** UI で「北極星が固定されている」バッジ条件 */
export function hasAnchoredNorthStar(ns: NorthStarMeta | null | undefined): boolean {
  return !!ns && ns.status === 'anchored' && !!ns.text;
}

/** UI で「候補が置かれている」バッジ条件（固定ではない） */
export function hasCandidateNorthStar(ns: NorthStarMeta | null | undefined): boolean {
  return !!ns && ns.status === 'candidate' && !!ns.text;
}

function clamp01(v: unknown): number | null {
  if (typeof v !== 'number' || Number.isNaN(v) || !Number.isFinite(v)) return null;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function normText(s: any): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function uniqEvidence(list: NorthStarEvidence[]): NorthStarEvidence[] {
  const seen = new Set<string>();
  const out: NorthStarEvidence[] = [];
  for (const e of list) {
    const key = `${e.type}:${e.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function boundedEvidence(list: NorthStarEvidence[], max = 12): NorthStarEvidence[] {
  if (list.length <= max) return list;
  return list.slice(list.length - max);
}

export function normalizeLlmNorthStar(raw: LlmNorthStarRaw | null | undefined): NorthStarMeta {
  const status: NorthStarStatus =
    raw?.status === 'candidate' || raw?.status === 'anchored' || raw?.status === 'released'
      ? raw.status
      : 'none';

  const text = raw?.text != null ? normText(raw.text) || null : null;
  const confidence = clamp01(raw?.confidence ?? null);
  const reason = raw?.reason ?? null;

  return {
    status,
    text,
    confidence,
    reason,
    updatedAt: null,
    evidence: [],
    event: 'none',
  };
}

export type NorthStarDecideInput = {
  nowIso: string;
  userText: string;

  /** “候補として置く/固定しない” を上流で検出した場合 */
  holdCandidate?: boolean;

  /** “固定する/北極星にする/SUNに合わせる” を上流で検出した場合 */
  anchorSet?: boolean;

  /** “リセット/固定しない/解除” を上流で検出した場合 */
  reset?: boolean;

  /** 上流で作った候補テキスト（例：situationSummary や inferredIntent） */
  candidateText?: string | null;

  /** 証拠（choice/action など）。 positivity だけでなく行動の証拠を入れる */
  evidence?: Array<{ type: NorthStarEvidenceType; strength: number; ref: string }>;
};

export type NorthStarDecideResult = {
  next: NorthStarMeta;
  changed: boolean;
};

/**
 * 重要ポリシー：
 * - reset は即時反映（released）
 * - holdCandidate は anchored への昇格を抑止して candidate 유지
 * - anchored への昇格は：
 *     1) anchorSet 明示  もしくは
 *     2) evidence strength の合計が閾値を越える（行動証拠）
 */
export function decideNorthStar(
  prev: NorthStarMeta | null | undefined,
  input: NorthStarDecideInput,
): NorthStarDecideResult {
  const nowIso = input.nowIso;
  const userText = normText(input.userText);
  const candidateText = normText(input.candidateText ?? '') || (userText ? userText.slice(0, 120) : '');

  const p: NorthStarMeta =
    prev && typeof prev === 'object'
      ? {
          status: prev.status ?? 'none',
          text: prev.text ?? null,
          confidence: prev.confidence ?? null,
          reason: prev.reason ?? null,
          updatedAt: prev.updatedAt ?? null,
          evidence: Array.isArray(prev.evidence) ? prev.evidence : [],
          event: prev.event ?? 'none',
        }
      : {
          status: 'none',
          text: null,
          confidence: null,
          reason: null,
          updatedAt: null,
          evidence: [],
          event: 'none',
        };

  // 1) reset
  if (input.reset) {
    const next: NorthStarMeta = {
      status: 'released',
      text: null,
      confidence: 0,
      reason: '北極星をリセット（固定を解除）',
      updatedAt: nowIso,
      evidence: [],
      event: 'reset',
    };
    return { next, changed: true };
  }

  // evidence merge
  const incoming = (input.evidence ?? [])
    .filter((x) => x && x.ref)
    .map((x) => ({
      type: x.type,
      strength: Math.max(0, Math.min(1, Number(x.strength ?? 0))),
      ref: String(x.ref),
      at: nowIso,
    }));

  const evidence = boundedEvidence(uniqEvidence([...(p.evidence ?? []), ...incoming]), 12);
  const sum = evidence.reduce((a, e) => a + Math.max(0, Math.min(1, e.strength)), 0);

  const promoteByExplicit = !!input.anchorSet;
  const promoteByEvidence = sum >= 1.8; // conservative default
  const shouldAnchor = promoteByExplicit || promoteByEvidence;

  // 2) hold candidate
  if (input.holdCandidate) {
    const next: NorthStarMeta = {
      status: 'candidate',
      text: candidateText || p.text || null,
      confidence: Math.max(0.2, Math.min(1, 0.2 + Math.min(0.8, sum / 3))),
      reason: '意図は候補として保持（まだ固定しない）',
      updatedAt: nowIso,
      evidence,
      event: 'hold_candidate',
    };
    return { next, changed: true };
  }

  // 3) normal flow
  if (p.status === 'anchored') {
    // anchored 維持（reset 以外では解除しない）
    const next: NorthStarMeta = {
      status: 'anchored',
      text: p.text ?? candidateText ?? null,
      confidence: Math.max(0.4, Math.min(1, 0.2 + Math.min(0.8, sum / 3))),
      reason: p.reason ?? '北極星を維持',
      updatedAt: nowIso,
      evidence,
      event: 'none',
    };
    return { next, changed: true };
  }

  // none/candidate/released -> candidate or anchored
  const nextStatus: NorthStarStatus = shouldAnchor ? 'anchored' : 'candidate';
  const next: NorthStarMeta = {
    status: nextStatus,
    text: candidateText || p.text || null,
    confidence:
      nextStatus === 'anchored'
        ? Math.max(0.4, Math.min(1, 0.2 + Math.min(0.8, sum / 3)))
        : Math.max(0.2, Math.min(1, 0.2 + Math.min(0.8, sum / 3))),
    reason:
      nextStatus === 'anchored'
        ? promoteByExplicit
          ? '北極星を固定（明示コミット）'
          : '北極星を固定（証拠の蓄積）'
        : '北極星は候補として保持',
    updatedAt: nowIso,
    evidence,
    event: nextStatus === 'anchored' ? 'anchor_set' : 'set_candidate',
  };

  const changed =
    next.status !== p.status ||
    next.text !== p.text ||
    next.reason !== p.reason ||
    String(next.updatedAt ?? '') !== String(p.updatedAt ?? '');

  return { next, changed };
}

/* ========= Orchestrator 統合の想定（例） =========
 *
 * - 既存：intentMeta は「I層の気配」
 * - 追加：northStar は「SUN固定/候補/解除」
 *
 * unified/meta にこう載せるイメージ：
 * meta: {
 *   intent: IntentMeta,
 *   northStar: NorthStarMeta,
 * }
 *
 * 重要：anchored への昇格条件は “ポジティブ感情” ではなく
 *       choice/action の evidence を根拠にする（あなたの方針と一致）
 */
