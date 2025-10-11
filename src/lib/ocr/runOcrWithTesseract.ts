// src/lib/ocr/runOcrWithTesseract.ts
'use client';
import Tesseract from 'tesseract.js';

export type OcrProgress = { status?: string; progress?: number };

const ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';
const BASE   = `${ORIGIN}/tesseract`;
const LANG_BASE = `${BASE}/lang-data`;

// SIMD/非SIMDのパス
const PATHS = {
  simd: {
    js:   `${BASE}/tesseract-core-simd.wasm.js?v=1`,
    wasm: `${BASE}/tesseract-core-simd.wasm?v=1`,
  },
  nosimd: {
    js:   `${BASE}/tesseract-core.wasm.js?v=1`,
    wasm: `${BASE}/tesseract-core.wasm?v=1`,
  },
};
const WORKER_PATH = `${BASE}/worker.min.js?v=1`;

// 実際に使う「現在の」パス（フォールバックで切替え）
let CURRENT = PATHS.simd;

/** cross-origin-isolated の方を優先して判定 */
function shouldUseSIMD() {
  if (typeof window === 'undefined') return false;
  if ((window as any).crossOriginIsolated) return true;
  // 念のため従来判定も併用
  return 'SharedArrayBuffer' in window;
}

export async function runOcrWithTesseract(
  file: File | Blob | string,
  lang: string = 'jpn',
  onProgress?: (p: OcrProgress) => void,
): Promise<string> {
  const logger = onProgress ? (m: any) => onProgress(m) : undefined;

  // 起動関数（SIMD/非SIMDを引数で切替）
  async function startWith(paths: { js: string; wasm: string }) {
    const worker = await (Tesseract as any).createWorker({
      workerPath: WORKER_PATH,
      corePath: paths.js,   // ← .wasm.js
      langPath: LANG_BASE,
      logger,
      // ← .wasm の場所を完全固定（CDN/キャッシュでのズレを防止）
      // @ts-ignore
      locateFile: (p: string) => (p.endsWith('.wasm') ? paths.wasm : p),
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

  // まず SIMD を試し、失敗したら非SIMDへ自動フォールバック
  try {
    CURRENT = shouldUseSIMD() ? PATHS.simd : PATHS.nosimd;
    return await startWith(CURRENT);
  } catch (e) {
    // 典型: 本番だけ "Failed to load TesseractCore"
    if (CURRENT !== PATHS.nosimd) {
      CURRENT = PATHS.nosimd;
      return await startWith(CURRENT);
    }
    throw e;
  }
}
