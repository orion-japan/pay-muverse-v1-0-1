'use client';
import Tesseract from 'tesseract.js';

export type OcrProgress = { status?: string; progress?: number };

/**
 * ★CDN固定（非SIMD）＋キャッシュバスター
 * ローカル /public/tesseract は一切使いません。
 */
export async function runOcrWithTesseract(
  file: File | Blob | string,
  lang: string = 'jpn',
  onProgress?: (p: OcrProgress) => void,
): Promise<string> {
  const V = 'v=2025-10-12-rollback2';

  const worker = await Tesseract.createWorker({
    workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@2.1.5/dist/worker.min.js?${V}`,
    corePath:   `https://cdn.jsdelivr.net/npm/tesseract.js-core@2.2.0/tesseract-core.wasm.js?${V}`, // 非SIMD固定
    langPath:   `https://cdn.jsdelivr.net/npm/tesseract.js-core@2.2.0/lang-data`,
    gzip:       true,
    logger:     (m) => onProgress?.(m),
  });

  await worker.load();
  await worker.loadLanguage(lang);
  await worker.initialize(lang);

  const { data: { text } } = await worker.recognize(file);

  await worker.terminate();
  return text;
}
