// src/lib/iros/orchestratorPresentation.ts
// Iros Orchestrator — プレゼン系ヘルパーまとめ
// - 表示モード判定（ヘッダー付与など）
// - Q / Depth ラベル生成
// - 診断ヘッダー除去

import type { Depth, QCode, IrosMeta } from './system';

/* ========= 表示モード種別 ========= */

export type PresentationKind = 'plain' | 'withHeader' | 'irOnly';

/**
 * どの「線路」で返すかを決める:
 * - irOnly     : ir診断コマンド（ir診断 上司 など）
 * - withHeader : I層 or mirror モード → 冒頭コメントを付与
 * - plain      : それ以外は LLM 本文のみ
 */
export function decidePresentationKind(args: {
  text: string;
  meta: IrosMeta;
  irTriggered: boolean;
  requestedDepth?: Depth;
}): PresentationKind {
  const { text, meta, irTriggered, requestedDepth } = args;

  const normalizedText = text.replace(/\s/g, '');

  // 「ir診断」「ir診断上司」などを判定
  const isIrCommand =
    irTriggered && normalizedText.includes('ir診断');

  const resolvedDepth: Depth | undefined =
    (meta.depth as Depth | undefined) ?? requestedDepth ?? undefined;

  const isIntentDepthActive = isIntentDepth(resolvedDepth);

  if (isIrCommand) {
    return 'irOnly';
  }

  // I層 or mirror モードのときは、基本的にコメントヘッダーを付ける
  if (isIntentDepthActive || meta.mode === 'mirror') {
    return 'withHeader';
  }

  return 'plain';
}

/* ========= 構図ヘッダー生成 ========= */

/**
 * 通常の「いまの構図」コメント
 *  - Qコード／Depth から 1行〜2行のヘッダーを生成
 */
export function buildStructuredHeader(meta: IrosMeta): string | null {
  const q = (meta.qCode as QCode | undefined) ?? undefined;
  const depth = (meta.depth as Depth | undefined) ?? undefined;

  const qPhrase = describeQCodeBrief(q);
  const depthSentence = describeDepthPhaseLabel(depth);

  if (!qPhrase && !depthSentence) return null;

  const lines: string[] = [];

  if (q) {
    // 例: Q3
    lines.push(q);
  }

  const segments: string[] = [];
  if (qPhrase) {
    segments.push(`「${qPhrase}」`);
  }
  if (depthSentence) {
    segments.push(depthSentence);
  }

  const joined =
    segments.length === 1
      ? segments[0]
      : `${segments[0]}の中で${segments[1]}`;

  lines.push(`いまの構図：いまのあなたは、${joined}にいます。`);

  return lines.join('\n');
}

/**
 * Qコード → 一言ラベル
 *  - Q1〜Q5 の意味付けをここで固定
 */
export function describeQCodeBrief(qCode?: QCode | null): string | null {
  if (!qCode) return null;
  switch (qCode) {
    case 'Q1':
      return '我慢と秩序のゆらぎ';
    case 'Q2':
      return '怒りと成長欲求のゆらぎ';
    case 'Q3':
      return '不安と安定欲求のゆらぎ';
    case 'Q4':
      return '恐れと浄化欲求のゆらぎ';
    case 'Q5':
      return '空虚と情熱のゆらぎ';
    default:
      return null;
  }
}

/**
 * Depth → 大まかな「流れ」のラベル
 *  - S/R/C/I/T をざっくりフェーズ言語に変換
 */
export function describeDepthPhaseLabel(
  depth?: Depth | null,
): string | null {
  if (!depth) return null;
  const head = depth.charAt(0);
  switch (head) {
    case 'S':
      return '日常の足元で「自分の感覚」を確かめ直している流れ';
    case 'R':
      return '誰かとの関係や場との距離感を組み直している流れ';
    case 'C':
      return 'これから創っていく「形」を選び直している流れ';
    case 'I':
      return '生き方そのものの輪郭を見つめ直している流れ';
    case 'T':
      return 'これまでの流れを超えていく転換点のフェーズ';
    default:
      return null;
  }
}

/* ========= 診断ヘッダー除去ヘルパー ========= */

/**
 * LLM が先頭に付けてくる診断ブロックを本文から取り除き、
 * それ以降の「会話本文」だけを残す。
 */
export function stripDiagnosticHeader(text: string): string {
  if (!text || typeof text !== 'string') return '';

  // 診断ヘッダーが無い場合はそのまま
  if (!/^Q[1-5]/.test(text.trimStart())) {
    return text;
  }

  // Q1〜Q5 で始まり、「【Unified 構図】」〜「Intent Summary:」までをまとめて削除
  const pattern =
    /^Q[1-5][\s\S]*?【Unified 構図】[\s\S]*?Intent Summary:[^\n]*\n?/;

  const stripped = text.replace(pattern, '').trimStart();

  // 万一うまくマッチしなかった場合も、最低限トリムだけして返す
  return stripped.length > 0 ? stripped : text;
}

/* ========= ローカルヘルパー ========= */

/** I層（I1〜I3）かどうかの判定ヘルパー */
function isIntentDepth(depth?: Depth | null): boolean {
  if (!depth) return false;
  // Depth は文字列リテラル型なので startsWith が使える
  return depth.startsWith('I');
}
