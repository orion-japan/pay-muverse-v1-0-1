// src/lib/mu/imageHook.ts
// ユーザーの明示的な画像化依頼を先にハンドリングする小さなフック。
// - 「画像にして」「画像を作って」「画像生成」などで反応
// - 返答は muConfig の文言/クレジットと連動
// - ここでは実行せず、まずスタイル確認まで（未指定=シンプル）

import { MU_BRIDGE_TEXT, MU_CREDITS } from './config';

const EXPLICIT_PATTERNS = [
  /画像にして/i,
  /画像を?作(っ)?て/i,
  /画像生成/i,
  /ビジュアル化/i,
  /イラスト化/i,
  /ポスター(を)?作/i,
  /サムネ(を)?作/i,
];

export function detectExplicitImageRequest(text: string): boolean {
  const t = text ?? '';
  return EXPLICIT_PATTERNS.some((re) => re.test(t));
}

export function buildImageStyleAsk(): string {
  const cost = Number.isFinite(MU_CREDITS.IMAGE_PER_GEN) ? MU_CREDITS.IMAGE_PER_GEN : 3;
  const suggest = MU_BRIDGE_TEXT.SUGGEST_IMAGE?.(cost)
    ?? `画像にしますか？（${cost}クレジット）—OKなら “画像にして” と返答してください。`;

  const ask = MU_BRIDGE_TEXT.ASK_STYLE
    ?? 'スタイル（写実/シンプル/手描き風）どれにします？（未指定はシンプル）';

  // 1行案内 → 次の一手でスタイル確認の流れ
  return `${suggest}\n${ask}`;
}
