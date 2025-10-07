// src/lib/ocr/ocrPipeline.ts
import Tesseract from 'tesseract.js';
import { cleanOcrText } from './cleanOcrText';
import {
  extractBubbleBlobs,
  upscaleTrimOnly,
  prepImageSoft,
  // なくても動くように typeof で存在チェックします
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  extractBubbleBlobsMeta,
} from './imagePrep';
import { postprocessOcr } from './postprocess';
import type { OcrResult, OcrPipelineOptions, LabeledMessage } from './types';

// ───────────────────────────────────────────────────────────────
// PSM 設定（型エラー回避＋一部環境での PSM 未反映対策）
const baseCfg: Record<string, any> = {
  langPath: '/tessdata-best',
  tessedit_ocr_engine_mode: '1',
  user_defined_dpi: '300',
  // 日本語は単語間スペース不要なので 0 推奨（字間スペースが出にくい）
  preserve_interword_spaces: '0',
  tessedit_char_whitelist:
    'ぁ-んァ-ヶ一-龥ーa-zA-Z0-9。、！？…「」『』（）()・%〜- ,.?!:\'"@',
  tessedit_char_blacklist:
    '§†‡¶•¤°¢™®©~`^_|<>[]{}■□◆◇▲△▼▽※♪♫＝≒≠≡╳╱╲',
};
const cfg = (psm: 6 | 7): any => ({
  ...baseCfg,
  tessedit_pageseg_mode: String(psm),
  config: `--psm ${psm} --oem 1 -c user_defined_dpi=${baseCfg.user_defined_dpi} -c preserve_interword_spaces=${baseCfg.preserve_interword_spaces}`,
});

// ───────────────────────────────────────────────────────────────
// 色だけに依存しない話者推定（位置優先→色補助→unknown）
function inferSideByMeta(
  m: { x1: number; y1: number; x2: number; y2: number; avgHue?: number; avgL?: number },
  pageW: number
): 'self' | 'partner' | 'unknown' {
  const cx = (m.x1 + m.x2) / 2;
  const rel = cx / Math.max(pageW, 1);

  // 1) 位置優先（右寄り=自分／左寄り=相手）
  if (rel >= 0.55) return 'self';
  if (rel <= 0.45) return 'partner';

  // 2) 色補助（任意）— 閾値を少し緩めて検出率UP
  if (m.avgHue != null && m.avgL != null) {
    const h = m.avgHue!, l = m.avgL!;
    const isGreen = h >= 70 && h <= 180 && l > 0.45; // 緑を広めに
    const isWhite = l > 0.78;                         // 白も少し緩め
    if (isGreen) return 'self';
    if (isWhite) return 'partner';
  }
  return 'unknown';
}

// メタが無い場合の色ヒューリスティック（従来互換）
async function detectBlobAvgHueL(blob: Blob): Promise<{ hue: number | null; l: number | null }> {
  const bmp = await createImageBitmap(blob);
  const w = bmp.width, h = bmp.height;
  const cw = Math.max(1, Math.floor(w / 8));
  const ch = Math.max(1, Math.floor(h / 8));
  const cvs = ('OffscreenCanvas' in globalThis)
    ? new OffscreenCanvas(cw, ch)
    : Object.assign(document.createElement('canvas'), { width: cw, height: ch }) as HTMLCanvasElement;
  // @ts-ignore
  if ('width' in cvs) { (cvs as any).width = cw; (cvs as any).height = ch; }
  const ctx = (cvs as any).getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, cw, ch);
  const data: Uint8ClampedArray = ctx.getImageData(0, 0, cw, ch).data;
  bmp.close();

  let rSum = 0, gSum = 0, bSum = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    rSum += data[i]; gSum += data[i + 1]; bSum += data[i + 2]; n++;
  }
  if (!n) return { hue: null, l: null };
  const r = rSum / (255 * n), g = gSum / (255 * n), b = bSum / (255 * n);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { hue: 0, l };
  const d = max - min;
  let hDeg = 0;
  if (max === g) hDeg = 60 * ((b - r) / d + 2);
  else if (max === b) hDeg = 60 * ((r - g) / d + 4);
  else hDeg = 60 * ((g - b) / d);
  if (hDeg < 0) hDeg += 360;
  return { hue: hDeg, l };
}
function inferSideByBlobColor(h: number | null, l: number | null): 'self' | 'partner' | 'unknown' {
  if (h == null || l == null) return 'unknown';
  const isGreen = h >= 70 && h <= 180 && l > 0.45;
  const isWhite = l > 0.78;
  if (isGreen) return 'self';
  if (isWhite) return 'partner';
  return 'unknown';
}

// unknown を前後で補間（交互前提）
function fillUnknownSides(seq: Array<'self' | 'partner' | 'unknown'>): Array<'self' | 'partner'> {
  const out: Array<'self' | 'partner'> = [];
  for (let i = 0; i < seq.length; i++) {
    const cur = seq[i];
    if (cur !== 'unknown') { out.push(cur); continue; }
    const prev = out[i - 1];
    const next = seq[i + 1] !== 'unknown' ? (seq[i + 1] as 'self' | 'partner') : undefined;
    if (prev && (!next || prev !== next)) out.push(prev === 'self' ? 'partner' : 'self');
    else if (next) out.push(next === 'self' ? 'partner' : 'self');
    else out.push('partner');
  }
  return out;
}

// A/B テキストへ整形（プレビュー用）。labeled が空なら null を返す。
function formatAB(labeled: LabeledMessage[]): string | null {
  if (!labeled.length) return null;
  // 連投は 1 行にまとめず、1 吹き出し = 1 行で出す
  const buf: string[] = [];
  for (const m of labeled) {
    const mark = m.side === 'self' ? 'A' : 'B';
    const t = (m.text || '').trim();
    if (!t) continue;
    buf.push(`${mark}${t.startsWith('「') || t.startsWith('（') ? '' : ''}${t}`);
  }
  return buf.join('\n');
}

// ───────────────────────────────────────────────────────────────

export async function runOcrPipeline(
  files: File[],
  opts: OcrPipelineOptions = {}
): Promise<OcrResult> {
  const lang = opts.lang || 'jpn';
  const pages: string[] = [];
  const labeled: LabeledMessage[] = [];

  for (let i = 0; i < files.length; i++) {
    try {
      // まずメタ版があれば使う（存在チェック）
      const hasMeta =
        typeof (extractBubbleBlobsMeta as unknown as (f: File) => any) === 'function';

      let pageText = '';

      if (hasMeta) {
        const metas: Array<{
          blob: Blob; x1: number; y1: number; x2: number; y2: number;
          avgHue: number; avgL: number; pageWidth: number; pageHeight: number;
        }> = await (extractBubbleBlobsMeta as any)(files[i]);

        const parts: string[] = [];
        const sidesTmp: Array<'self' | 'partner' | 'unknown'> = [];

        for (const m of metas) {
          const buf = await m.blob.arrayBuffer();
          const r = await Tesseract.recognize(buf as any, lang, cfg(7) as any);
          const t = cleanOcrText(r?.data?.text ?? '').trim();
          if (!t) { sidesTmp.push('unknown'); continue; }
          parts.push(t);
          sidesTmp.push(inferSideByMeta(m, m.pageWidth));
        }

        const sides = fillUnknownSides(sidesTmp);

        for (let k = 0; k < parts.length; k++) {
          labeled.push({
            text: parts[k],
            side: sides[k],
            confidence: sidesTmp[k] === 'unknown' ? 0.6 : 0.85,
            xCenter: sides[k] === 'self' ? 0.8 : 0.2,
            yTop: 0, yBottom: 0,
          });
        }

        pageText = parts.join('\n');
      } else {
        // メタなし：既存の Blob[] で処理し、色から推定
        let bubbles: Blob[] = [];
        try { bubbles = await extractBubbleBlobs(files[i]); } catch { /* noop */ }

        if (bubbles.length) {
          const parts: string[] = [];
          const sidesTmp: Array<'self' | 'partner' | 'unknown'> = [];
          for (const b of bubbles) {
            const { hue, l } = await detectBlobAvgHueL(b);
            const sideGuess = inferSideByBlobColor(hue, l);
            const buf = await b.arrayBuffer();
            const r = await Tesseract.recognize(buf as any, lang, cfg(7) as any);
            const t = cleanOcrText(r?.data?.text ?? '').trim();
            if (!t) { sidesTmp.push('unknown'); continue; }
            parts.push(t);
            sidesTmp.push(sideGuess);
          }
          const sides = fillUnknownSides(sidesTmp);
          for (let k = 0; k < parts.length; k++) {
            labeled.push({
              text: parts[k],
              side: sides[k],
              confidence: sidesTmp[k] === 'unknown' ? 0.55 : 0.8,
              xCenter: sides[k] === 'self' ? 0.8 : 0.2,
              yTop: 0, yBottom: 0,
            });
          }
          pageText = parts.join('\n');
        } else {
          // バブル抽出に失敗：ページ丸ごとフォールバック（従来）
          const safe = await prepImageSoft(files[i]);
          const buf = await safe.arrayBuffer();

          const r1 = await Tesseract.recognize(buf as any, lang, cfg(6) as any);
          let t = cleanOcrText(r1?.data?.text ?? '');

          const conf = r1?.data?.confidence ?? 0;
          const bad =
            (t.match(/[^\wぁ-んァ-ヶ一-龥。、！？…「」『』（）()・%〜\s-]/g) || []).length /
            Math.max(t.length || 1, 1);

          if (conf < 86 || bad > 0.07) {
            try {
              const r2 = await Tesseract.recognize(buf as any, lang, cfg(7) as any);
              const t2 = cleanOcrText(r2?.data?.text ?? '');
              if (t2.length > t.length * 0.7) t = t2;
            } catch { /* keep t */ }
          }
          pageText = t;

          // フォールバック時は「句点で区切って交互割当（低信頼）」で labeled を作る
          const cand = postprocessOcr(pageText)
            .split(/\r?\n+/)
            .flatMap(line => line.split(/(?<=[。！？!?])/));
          for (let k = 0; k < cand.length; k++) {
            const text = cand[k].trim();
            if (!text) continue;
            labeled.push({
              text,
              side: (k % 2 === 0) ? 'partner' : 'self', // 低信頼
              confidence: 0.4,
              xCenter: (k % 2 === 0) ? 0.2 : 0.8,
              yTop: 0, yBottom: 0,
            });
          }
        }
      }

      // 後処理（字間スペース除去・句読点整形・行結合）
      pageText = postprocessOcr(pageText || '');
      pages.push(pageText);
    } catch (e) {
      console.warn('[OCR] page failed', i + 1, e);
      pages.push('');
    }
  }

  // labeled が取れていれば A/B 付きで rawText を整形、なければ従来の連結
  const ab = formatAB(labeled);
  const rawText = ab
    ? `【#1】\n${ab}` // 複数ページの場合は必要に応じて拡張
    : postprocessOcr(pages.map((t, i) => `【#${i + 1}】\n${t}`).join('\n\n').trim());

  return { rawText, pages, labeled };
}
