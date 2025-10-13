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
// 404対策：Tesseractアセットを「CDN」に固定（言語は Naptha 公式 tessdata）
// さらに本番でのクロスオリジン Worker 対策として workerBlobURL を利用します。
export const OCR_CDN_VERSION = 'cdn-2025-10-13';
export const WORKER_PATH: string =
  `https://cdn.jsdelivr.net/npm/tesseract.js@2.1.5/dist/worker.min.js?${OCR_CDN_VERSION}`;
// 非SIMD版（互換性重視）。SIMDが安定する環境なら simd版に差し替えてOK
export const CORE_PATH: string =
  `https://cdn.jsdelivr.net/npm/tesseract.js-core@2.2.0/tesseract-core.wasm.js?${OCR_CDN_VERSION}`;
// ✅ 正しい言語データのベースURL（※ .gz まで直書きしない）
export const LANG_BASE: string =
  '/tesseract/lang-data';

// 呼び出し側がまとめて受け取れるように公開
export type OcrPaths = { workerPath: string; corePath: string; langPath: string };
export function getOcrCdnPaths(): OcrPaths {
  return { workerPath: WORKER_PATH, corePath: CORE_PATH, langPath: LANG_BASE };
}
// ───────────────────────────────────────────────────────────────

// PSM 設定
const baseCfg: Record<string, any> = {
  langPath: LANG_BASE,
  tessedit_ocr_engine_mode: '1',
  user_defined_dpi: '300',
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

// Tesseract.recognize に渡すオプション（常にCDNパス）
// 本番安定化のため workerBlobURL: true を付与（外部CDNのWorkerをblobラップして起動）
const tessOpts = (psm: 6 | 7) =>
  ({
    ...cfg(psm),
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    langPath: LANG_BASE,
    workerBlobURL: true,
    logger: () => {},
  } as any);

// ───────────────────────────────────────────────────────────────
// （以下は元の処理ロジックそのまま）
function inferSideByMeta(
  m: { x1: number; y1: number; x2: number; y2: number; avgHue?: number; avgL?: number },
  pageW: number
): 'self' | 'partner' | 'unknown' {
  const cx = (m.x1 + m.x2) / 2;
  const rel = cx / Math.max(pageW, 1);
  if (rel >= 0.55) return 'self';
  if (rel <= 0.45) return 'partner';
  if (m.avgHue != null && m.avgL != null) {
    const h = m.avgHue!, l = m.avgL!;
    const isGreen = h >= 70 && h <= 180 && l > 0.45;
    const isWhite = l > 0.78;
    if (isGreen) return 'self';
    if (isWhite) return 'partner';
  }
  return 'unknown';
}

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

function formatAB(labeled: LabeledMessage[]): string | null {
  if (!labeled.length) return null;
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
          const r = await Tesseract.recognize(buf as any, lang, tessOpts(7));
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
        let bubbles: Blob[] = [];
        try { bubbles = await extractBubbleBlobs(files[i]); } catch { /* noop */ }

        if (bubbles.length) {
          const parts: string[] = [];
          const sidesTmp: Array<'self' | 'partner' | 'unknown'> = [];
          for (const b of bubbles) {
            const { hue, l } = await detectBlobAvgHueL(b);
            const sideGuess = inferSideByBlobColor(hue, l);
            const buf = await b.arrayBuffer();
            const r = await Tesseract.recognize(buf as any, lang, tessOpts(7));
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
          const safe = await prepImageSoft(files[i]);
          const buf = await safe.arrayBuffer();

          const r1 = await Tesseract.recognize(buf as any, lang, tessOpts(6));
          let t = cleanOcrText(r1?.data?.text ?? '');

          const conf = r1?.data?.confidence ?? 0;
          const bad =
            (t.match(/[^\wぁ-んァ-ヶ一-龥。、！？…「」『』（）()・%〜\s-]/g) || []).length /
            Math.max(t.length || 1, 1);

          if (conf < 86 || bad > 0.07) {
            try {
              const r2 = await Tesseract.recognize(buf as any, lang, tessOpts(7));
              const t2 = cleanOcrText(r2?.data?.text ?? '');
              if (t2.length > t.length * 0.7) t = t2;
            } catch { /* keep t */ }
          }
          pageText = t;

          const cand = postprocessOcr(pageText)
            .split(/\r?\n+/)
            .flatMap(line => line.split(/(?<=[。！？!?])/));
          for (let k = 0; k < cand.length; k++) {
            const text = cand[k].trim();
            if (!text) continue;
            labeled.push({
              text,
              side: (k % 2 === 0) ? 'partner' : 'self',
              confidence: 0.4,
              xCenter: (k % 2 === 0) ? 0.2 : 0.8,
              yTop: 0, yBottom: 0,
            });
          }
        }
      }

      pageText = postprocessOcr(pageText || '');
      pages.push(pageText);
    } catch (e) {
      console.warn('[OCR] page failed', i + 1, e);
      pages.push('');
    }
  }

  const ab = formatAB(labeled);
  const rawText = ab
    ? `【#1】\n${ab}`
    : postprocessOcr(pages.map((t, i) => `【#${i + 1}】\n${t}`).join('\n\n').trim());

  return { rawText, pages, labeled };
}
