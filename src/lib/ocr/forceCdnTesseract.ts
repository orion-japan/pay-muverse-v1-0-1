// src/lib/ocr/ocrPipeline.ts
// 以前の /tesseract/ ローカル参照を完全にやめ、CDN（非SIMD）に固定します。
// ここを参照している全コードは自動的に CDN を使います。

const V = 'rev-cdn-2025-10-12-1'; // キャッシュバスター（値を変えると確実に再取得）

export const WORKER_PATH = `https://cdn.jsdelivr.net/npm/tesseract.js@2.1.5/dist/worker.min.js?${V}`;

export const CORE_PATH = `https://cdn.jsdelivr.net/npm/tesseract.js-core@2.2.0/tesseract-core.wasm.js?${V}`;

export const LANG_BASE = `https://cdn.jsdelivr.net/npm/tesseract.js-core@2.2.0/lang-data`;

// 互換用のヘルパ（呼び出し側がオブジェクトで受けたい場合）
export function getOcrCdnPaths() {
  return { workerPath: WORKER_PATH, corePath: CORE_PATH, langPath: LANG_BASE };
}
