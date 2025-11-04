// src/lib/ocr/extractMessages.ts
import type { OcrBlock, OcrMessage } from './types';

/** さまざまな座標表現を x0,y0,x1,y1 に正規化 */
function normXY(
  b: OcrBlock & {
    // どれかが来るかもしれないので “任意プロパティ” として受ける
    x0?: number;
    y0?: number;
    x1?: number;
    y1?: number;
    left?: number;
    top?: number;
    right?: number;
    bottom?: number;
    bbox?: { x0: number; y0: number; x1: number; y1: number };
    page?: number;
  },
) {
  const x0 = b.x0 ?? b.left ?? b.bbox?.x0 ?? 0;
  const y0 = b.y0 ?? b.top ?? b.bbox?.y0 ?? 0;
  const x1 = b.x1 ?? b.right ?? b.bbox?.x1 ?? x0;
  const y1 = b.y1 ?? b.bottom ?? b.bbox?.y1 ?? y0;
  const page = typeof b.page === 'number' ? b.page : 0;
  return { x0, y0, x1, y1, page };
}

/**
 * OCRブロック配列（複数画像ページ分）を “吹き出し相当” に寄せます。
 * ざっくり：y順で並べ、小さな縦間隔で連結し、x中心を計算。
 * 構造は OcrMessage[] のまま変更しません。
 */
export function extractMessages(blocks: OcrBlock[]): OcrMessage[] {
  // 1) 空/ノイズ除外＋幾何量を付加
  const items = (blocks || [])
    .map((raw) => {
      const txt = String(raw?.text || '').trim();
      if (!txt) return null;
      const { x0, y0, x1, y1, page } = normXY(raw as any);
      return {
        text: txt,
        xCenter: (x0 + x1) / 2,
        yTop: y0,
        width: Math.max(1, x1 - x0),
        height: Math.max(1, y1 - y0),
        page,
      } as OcrMessage;
    })
    .filter((v): v is OcrMessage => !!v);

  // 2) ページ→y→x で安定ソート
  items.sort((a, b) => a.page - b.page || a.yTop - b.yTop || a.xCenter - b.xCenter);

  // 3) 近い行を結合（縦距離しきい値：ブロック高さの 0.8）
  const merged: OcrMessage[] = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (
      last &&
      it.page === last.page &&
      Math.abs(it.yTop - last.yTop) < Math.min(it.height, last.height) * 0.8 &&
      Math.abs(it.xCenter - last.xCenter) < Math.max(it.width, last.width)
    ) {
      // 同じ吹き出しとして連結
      merged[merged.length - 1] = {
        text: `${last.text}\n${it.text}`,
        xCenter: (last.xCenter + it.xCenter) / 2,
        yTop: Math.min(last.yTop, it.yTop),
        width: Math.max(last.width, it.width),
        height: last.height + it.height,
        page: it.page,
      };
    } else {
      merged.push(it);
    }
  }

  // 4) 連続重複の軽い除去
  const dedup: OcrMessage[] = [];
  for (const m of merged) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.text === m.text && Math.abs(prev.xCenter - m.xCenter) < 6) continue;
    dedup.push(m);
  }

  return dedup;
}
