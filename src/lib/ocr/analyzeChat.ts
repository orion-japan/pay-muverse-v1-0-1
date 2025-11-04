// src/lib/ocr/analyzeChat.ts
import type { LabeledMessage, AnalyzeChatOptions } from './types';

type BubbleItem = {
  text: string;
  xCenter?: number; // 0..1（右ほど大）
  colorHint?: 'green' | 'white' | 'other'; // 画像からのヒント（任意）
  readAfter?: boolean; // 直後に「既読」が来たか（テキスト解析から）
};

function scoreFromPosition(xc?: number, selfIsRight = true) {
  if (typeof xc !== 'number') return 0;
  const right = xc > 0.5;
  // 右=自分（既定）なら右寄りがプラス、左寄りがマイナス
  return right === selfIsRight ? +2 : -2;
}

function scoreFromColor(c?: 'green' | 'white' | 'other', selfIsRight = true) {
  // LINE標準：自分=緑/相手=白。ただしテーマで変わるため重みは控えめ
  if (!c) return 0;
  if (c === 'green') return +1; // 自分寄り
  if (c === 'white') return -1; // 相手寄り
  return 0;
}

function scoreFromRead(readAfter?: boolean) {
  // 「既読」は通常“自分の直前の吹き出し”に出る ⇒ 自分寄り+1
  return readAfter ? +1 : 0;
}

export function analyzeChat(items: BubbleItem[], opts: AnalyzeChatOptions = {}): LabeledMessage[] {
  const selfIsRight = opts.selfIsRight ?? opts.selfSideHint === 'right'; // 右=自分を既定

  // スコアリング
  const labeled = items.map((b, i) => {
    const pos = scoreFromPosition(b.xCenter, selfIsRight);
    const col = scoreFromColor(b.colorHint, selfIsRight);
    const rd = scoreFromRead(b.readAfter);
    const total = pos + col + rd; // 位置を主、色/既読は補助

    const self = total > 0 ? true : total < 0 ? false : undefined;

    return {
      text: (b.text || '').trim(),
      yTop: i / Math.max(items.length, 1),
      yBottom: (i + 1) / Math.max(items.length, 1),
      xCenter: b.xCenter ?? 0.5,
      side: self === undefined ? 'partner' : self ? 'self' : 'partner', // 一旦仮
      confidence: Math.min(1, Math.max(0.4, 0.6 + 0.1 * total)), // 0.4〜1.0
    } as LabeledMessage;
  });

  // フェイルセーフ1：全て同じ側になった場合は“交互補正”
  const allSame = labeled.every((l) => l.side === labeled[0]?.side);
  if (allSame && labeled.length >= 2) {
    for (let i = 1; i < labeled.length; i++) {
      labeled[i].side = labeled[i - 1].side === 'self' ? 'partner' : 'self';
      labeled[i].confidence = Math.min(labeled[i].confidence, 0.55);
    }
  }

  // フェイルセーフ2：疑問→返答のペアが続くときは左右が交互になるよう微調整
  const qmark = /[?？]$/;
  for (let i = 1; i < labeled.length; i++) {
    const prev = labeled[i - 1],
      cur = labeled[i];
    if (prev.text && cur.text) {
      const shouldAlternate = qmark.test(prev.text) || qmark.test(cur.text);
      if (shouldAlternate && prev.side === cur.side) {
        cur.side = prev.side === 'self' ? 'partner' : 'self';
        cur.confidence = Math.min(cur.confidence, 0.6);
      }
    }
  }

  return labeled;
}
