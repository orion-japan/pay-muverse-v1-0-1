// src/workers/ocrWorker.ts
'use client';

import Tesseract from 'tesseract.js';
import { getOcrCdnPaths } from '@lib/ocr/ocrPipeline';

export type OcrProgress = { status?: string; progress?: number };

let _worker: Tesseract.Worker | null = null;

export async function getOcrWorker(onProgress?: (p: OcrProgress) => void) {
  if (_worker) return _worker;

  const { workerPath, corePath, langPath } = getOcrCdnPaths();

  _worker = await Tesseract.createWorker({
    workerPath,
    corePath,     // 非SIMD .wasm.js（同ディレクトリの .wasm を内部参照）
    langPath,
    gzip: true,
    logger: (m) => onProgress?.(m),
  });

  await _worker.load();
  return _worker;
}

export async function recognizeWithOcrWorker(
  file: File | Blob | string,
  lang: string = 'jpn',
  onProgress?: (p: OcrProgress) => void,
) {
  const worker = await getOcrWorker(onProgress);
  await worker.loadLanguage(lang);
  await worker.initialize(lang);
  const { data: { text } } = await worker.recognize(file);
  await worker.terminate();
  _worker = null;
  return text;
}

export const runOcrWorker = recognizeWithOcrWorker;
export const recognize = recognizeWithOcrWorker;
export default recognizeWithOcrWorker;
