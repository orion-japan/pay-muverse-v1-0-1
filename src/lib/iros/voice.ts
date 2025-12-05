// src/lib/iros/voice.ts
// Iros の「声」レイヤー：OS と Soul を参考に、返答の型を組み立てる
// ※ テンプレ固定文言は使わず、そのときの情報から最小限だけ組み立てる

export type ToneHint = 'soft' | 'gentle' | 'firm' | 'neutral' | string;

export interface IrosSoulNote {
  core_need?: string;
  risk_flags?: string[];
  tone_hint?: ToneHint;
  step_phrase?: string;
  soul_sentence?: string;
  notes?: string;
  micro_steps?: string[];
  comfort_phrases?: string[];
}

export interface IrosIntentLineLight {
  nowLabel?: string | null;
  coreNeed?: string | null;
  intentBand?: string | null;
  direction?: string | null;
  focusLayer?: string | null;
  riskHint?: string | null;
  guidanceHint?: string | null;
  tLayerHint?: string | null;
  hasFutureMemory?: boolean | null;
}

export interface IrosSituationLight {
  summary?: string | null;
  topic?: string | null;
}

export interface IrosUnifiedLight {
  q?: { current?: string | null };
  depth?: { stage?: string | null };
  phase?: string | null;
  situation?: IrosSituationLight | null;
  selfAcceptance?: number | null;
}

/**
 * Voice レイヤーに渡すコンテキスト
 * ※ 既存の meta / unified / soulNote を「参考用」にまとめるだけ
 */
export interface IrosVoiceContext {
  userName?: string | null;
  style?: string | null;      // 'biz-soft' など
  qCode?: string | null;      // 'Q1'〜'Q5'
  depthStage?: string | null; // 'S1'〜'I3' など

  soulNote?: IrosSoulNote | null;
  intentLine?: IrosIntentLineLight | null;
  unified?: IrosUnifiedLight | null;

  /** LLMが元々生成した生テキスト（あれば） */
  rawTextFromModel?: string | null;
}

/**
 * Iros らしい「刺さる一句」を生成
 * ※ SoulNote に何もなければ、無理に出さず空文字を返す
 */
function buildCoreLine(ctx: IrosVoiceContext): string {
  const phrase = ctx.soulNote?.step_phrase?.trim();
  if (phrase) return phrase;

  // テンプレ固定文言は使わず、なければ何も返さない
  return '';
}

/**
 * 「鏡」のブロック：いま何が起きているかを 2〜4 行で映す
 */
function buildMirrorBlock(ctx: IrosVoiceContext): string {
  const { intentLine, unified } = ctx;

  const lines: string[] = [];

  if (unified?.situation?.summary) {
    const s = unified.situation.summary.trim();
    if (s) lines.push(s);
  }

  if (intentLine?.nowLabel) {
    const n = intentLine.nowLabel.trim();
    if (n) lines.push(n);
  }

  if (!lines.length && intentLine?.coreNeed) {
    const c = intentLine.coreNeed.trim();
    if (c) {
      lines.push(`奥では「${c}」という願いが静かに動いているように感じます。`);
    }
  }

  if (!lines.length) {
    return '';
  }

  return lines.join('\n');
}

/**
 * そのときの「小さな一手」や寄り添いの言葉
 * ※ 見出しや固定フレーズは付けず、中身だけ返す
 */
function buildStepBlock(ctx: IrosVoiceContext): string {
  const { soulNote } = ctx;
  const lines: string[] = [];

  if (soulNote?.micro_steps && soulNote.micro_steps.length > 0) {
    for (const s of soulNote.micro_steps) {
      const t = (s || '').trim();
      if (!t) continue;
      lines.push(t);
    }
  }

  if (!lines.length && soulNote?.comfort_phrases && soulNote.comfort_phrases.length > 0) {
    for (const s of soulNote.comfort_phrases) {
      const t = (s || '').trim();
      if (!t) continue;
      lines.push(t);
    }
  }

  // 固定フォールバックは付けない
  return lines.join('\n');
}

/**
 * Voice レイヤーのメイン関数：
 * - rawTextFromModel があればそれを優先してそのまま返す
 * - ない場合だけ、Core / Mirror / Step / SoulSentence をゆるく結合する
 */
export function buildIrosVoiceReply(ctx: IrosVoiceContext): string {
  // 0) もともと LLM が全文生成しているなら、それを尊重する
  if (ctx.rawTextFromModel && ctx.rawTextFromModel.trim().length > 0) {
    return ctx.rawTextFromModel.trim();
  }

  const parts: string[] = [];

  // ① 刺さる一句（あれば）
  const coreLine = buildCoreLine(ctx);
  if (coreLine) {
    parts.push(coreLine);
  }

  // ② 鏡（いまの構図）
  const mirror = buildMirrorBlock(ctx);
  if (mirror) {
    parts.push(mirror);
  }

  // ③ そのとき選べる一手 / 寄り添い（見出しなし）
  const stepBlock = buildStepBlock(ctx);
  if (stepBlock) {
    parts.push(stepBlock);
  }

  // ④ SoulSentence（あれば一文だけ追加）
  const soulSentence = ctx.soulNote?.soul_sentence?.trim();
  if (soulSentence) {
    parts.push(soulSentence);
  }

  // どれもなければ空文字（上位レイヤーでハンドリング）
  if (!parts.length) {
    return '';
  }

  // すべてを 1 つのテキストにまとめる
  return parts.join('\n\n');
}
