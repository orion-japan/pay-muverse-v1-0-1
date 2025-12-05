// src/lib/iros/orchestratorPresentation.ts
// Iros Orchestrator — プレゼン系ヘルパーまとめ
// - 表示モード判定（ヘッダー付与など）
// - 診断ヘッダー除去
//
// ★ テンプレゼロ版：構図ヘッダー文章は一切生成しない

import type { Depth, QCode, IrosMeta } from './system';

/* ========= 表示モード種別 ========= */

export type PresentationKind = 'plain' | 'withHeader' | 'irOnly';

/**
 * どの「線路」で返すかを決める:
 * - irOnly : ir診断コマンド（ir診断 上司 など）
 * - plain  : それ以外は LLM 本文のみ
 *
 * ※ テンプレゼロ方針のため、withHeader は現在使用しない
 */
export function decidePresentationKind(args: {
  text: string;
  meta: IrosMeta;
  irTriggered: boolean;
  requestedDepth?: Depth;
}): PresentationKind {
  const { text, irTriggered } = args;

  const normalizedText = text.replace(/\s/g, '');

  // 「ir診断」「ir診断上司」などを判定
  const isIrCommand =
    irTriggered && normalizedText.includes('ir診断');

  if (isIrCommand) {
    return 'irOnly';
  }

  // 通常はすべてプレーン（LLM本文のみ）
  return 'plain';
}

/* ========= 構図ヘッダー生成 ========= */

/**
 * 通常の「いまの構図」コメント
 *  - ★ テンプレゼロ方針のため、現在は何も返さない
 */
export function buildStructuredHeader(_meta: IrosMeta): string | null {
  return null;
}

/**
 * Qコード → 一言ラベル
 *  - いまは直接 UI には出さないが、
 *    将来の構造ラベル用に残しておく
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
 *  - これも meta 用の構造ラベルとして温存
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
  return depth.startsWith('I');
}
