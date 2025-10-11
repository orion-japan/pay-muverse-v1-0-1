// src/lib/ocr/runOcrWithTesseract.ts
'use client';

import Tesseract from 'tesseract.js';

export type OcrProgress = { status?: string; progress?: number };

const BASE = '/tesseract';
const WORKER_PATH = `${BASE}/worker.min.js`;

// SIMD あり/なしを自動切替
const CORE_JS = ('SharedArrayBuffer' in (globalThis as any))
  ? `${BASE}/tesseract-core-simd.wasm.js`
  : `${BASE}/tesseract-core.wasm.js`;

const CORE_WASM = ('SharedArrayBuffer' in (globalThis as any))
  ? `${BASE}/tesseract-core-simd.wasm`
  : `${BASE}/tesseract-core.wasm`;

const LANG_BASE = `${BASE}/lang-data`; // jpn.traineddata.gz を配置

export async function runOcrWithTesseract(
  file: File | Blob | string,
  lang: string = 'jpn',
  onProgress?: (p: OcrProgress) => void,
): Promise<string> {
  const logger = onProgress ? (m: any) => onProgress(m) : undefined;

  const worker = await (Tesseract as any).createWorker({
    workerPath: WORKER_PATH,
    corePath: CORE_JS,     // ← .wasm.js
    langPath: LANG_BASE,
    logger,
    // ← ここが重要：.wasm の実体パスを固定
    // @ts-ignore
    locateFile: (p: string) => (p.endsWith('.wasm') ? CORE_WASM : p),
  });

  try {
    await worker.load();
    await worker.loadLanguage(lang);
    await worker.initialize(lang);
    const { data: { text } } = await worker.recognize(file);
    return text ?? '';
  } finally {
    try { await worker.terminate(); } catch {}
  }
}
