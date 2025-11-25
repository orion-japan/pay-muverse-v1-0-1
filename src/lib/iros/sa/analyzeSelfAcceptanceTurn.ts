// src/lib/iros/sa/analyzeSelfAcceptanceTurn.ts
// Self Acceptance（自己受容度）専用：
// - プロンプト生成
// - JSON結果のパース
// ※ ここでは LLM 呼び出しまでは行わない（上位レイヤーで chatComplete などに接続）

import type { QCode, Depth } from '../system';

/* ========= 型定義 ========= */

export type SelfAcceptanceInput = {
  userText: string;
  assistantText: string;
  qCode: QCode | null;
  depthStage: Depth | null;
  phase: 'Inner' | 'Outer' | null;
};

export type SelfAcceptanceRawJson = {
  self_acceptance?: number;
  selfAcceptance?: number;
  reason?: string | null;
};

export type SelfAcceptanceResult = {
  /** 0.0〜1.0 にクランプ済み。解析失敗時は null */
  value: number | null;
  /** なぜその値になったかのテキスト（あれば） */
  reason: string | null;
};

/* ========= clamp ヘルパー ========= */

export function clampSelfAcceptance(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(1, value));
  return clamped;
}

/* ========= SYSTEM プロンプト生成 ========= */

export function buildSelfAcceptanceSystemPrompt(): string {
  return [
    'あなたは「Self Acceptance（自己受容度）」を数値化するアナリストです。',
    '',
    '評価対象は、ある1ターンの対話です。',
    'ユーザーの発言（user_text）と、AIの返答（assistant_text）、解析済みのQコードや深度などが与えられます。',
    '',
    'あなたの仕事は、',
    '「このターンのあと、その相談テーマについてユーザーがどの程度、自分自身を責めずに受け入れられているか」',
    'を、0.0〜1.0の数値で表現することです。',
    '',
    '重要なポイント：',
    '- 評価するのは「人生全体の自己肯定感」ではなく、「このテーマ、この瞬間の自己受容度」です。',
    '- ネガティブな感情（不安、怒り、悲しみなど）があること自体は、自己受容度の低さを意味しません。',
    '  - 「不安だけど、こう感じる自分は自然だと思えている」場合は、Self Acceptance は中〜高めになります。',
    '- 自己受容度が低いときは、',
    '  - 「全部自分が悪い」「自分には価値がない」「消えたい」など、存在レベルの否定が強くなります。',
    '- 自己受容度が高いときは、',
    '  - 「今の自分でもいい」「ここまでよく頑張っている」「こう感じるのは当然だ」といった、今の自分を許すニュアンスが含まれます。',
    '',
    'スケールの目安：',
    '- 0.00〜0.20：存在そのものを強く否定している（消えてしまいたい、自分には価値がない等）。',
    '- 0.20〜0.40：状況だけでなく、自分を責める言葉が多い（〜できない自分はダメ等）。',
    '- 0.40〜0.60：自己否定と自己受容のあいだで揺れている（責めつつも、どこかで仕方ないとも感じている）。',
    '- 0.60〜0.80：つらさがあっても、自分をある程度許せている（この反応は自然、よく頑張っている等）。',
    '- 0.80〜1.00：感情も選択も含めて、かなり安定して自分を肯定できている状態。',
    '',
    '出力は、必ず次の形式のJSONだけにしてください：',
    '',
    '{',
    '  "self_acceptance": 数値,   // 0.0〜1.0',
    '  "reason": "その値にした簡潔な理由"',
    '}',
    '',
    '説明文やコメントは一切出力せず、このJSONオブジェクトだけを返してください。',
  ].join('\n');
}

/* ========= USER プロンプト生成 ========= */

export function buildSelfAcceptanceUserPrompt(
  input: SelfAcceptanceInput,
): string {
  const payload = {
    user_text: input.userText,
    assistant_text: input.assistantText,
    q_code: input.qCode,
    depth_stage: input.depthStage,
    phase: input.phase,
  };

  return [
    '次のJSONは、ある1ターンの対話情報です。',
    '',
    '- user_text: ユーザーの発言',
    '- assistant_text: AIの返答（そのターンの本文）',
    '- q_code: 解析済みのQコード（Q1〜Q5）',
    '- depth_stage: 解析済みの深度（S1〜I3）',
    '- phase: Inner / Outer / null',
    '',
    'この情報から、',
    '「このターンのあと、その相談テーマについてユーザーがどの程度、自分を責めずに受け入れられているか」',
    'を0.0〜1.0で評価してください。',
    '',
    'JSON:',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

/* ========= LLM結果のパース ========= */

/**
 * LLM から返ってきた JSON（文字列 or オブジェクト）を解析して、
 * 0.0〜1.0 にクランプした SelfAcceptanceResult を返す。
 */
export function parseSelfAcceptanceResult(
  raw: string | unknown,
): SelfAcceptanceResult {
  let obj: SelfAcceptanceRawJson | null = null;

  try {
    if (typeof raw === 'string') {
      obj = JSON.parse(raw) as SelfAcceptanceRawJson;
    } else if (raw && typeof raw === 'object') {
      obj = raw as SelfAcceptanceRawJson;
    }
  } catch (e) {
    console.error('[SA] failed to parse JSON from raw result', e);
    return { value: null, reason: null };
  }

  if (!obj) {
    return { value: null, reason: null };
  }

  const saRaw =
    typeof obj.self_acceptance === 'number'
      ? obj.self_acceptance
      : typeof obj.selfAcceptance === 'number'
      ? obj.selfAcceptance
      : null;

  const value = clampSelfAcceptance(saRaw);
  const reason =
    typeof obj.reason === 'string' && obj.reason.trim().length > 0
      ? obj.reason.trim()
      : null;

  return { value, reason };
}
