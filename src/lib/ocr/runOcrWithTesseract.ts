'use client';


// ブラウザ実行専用。SSRでは使わないこと
// Tesseract v2.1.5 を想定
import Tesseract from 'tesseract.js';


// ===== パス設定（public/ 配下の実ファイルと一致させる） =====
const WORKER_PATH = '/tesseract/worker.min.js';


// Safari 等 SIMD 非対応ブラウザを考慮して自動切り替え
const CORE_PATH = (typeof window !== 'undefined' && 'SharedArrayBuffer' in window)
? '/tesseract/tesseract-core-simd.wasm.js'
: '/tesseract/tesseract-core.wasm.js'; // 非SIMD版も同梱しておくと安全


const LANG_BASE = '/tesseract/lang-data'; // jpn.traineddata.gz を配置


export type OcrProgress = { status?: string; progress?: number };


export async function runOcrWithTesseract(
file: File | Blob | string, // File/Blob/URL いずれも可
lang: 'jpn' | 'eng' | string = 'jpn',
onProgress?: (p: OcrProgress) => void,
): Promise<string> {
const logger = onProgress ? (m: any) => onProgress(m) : undefined;


// createWorker の引数で外部資産のパスを明示
const worker = await (Tesseract as any).createWorker({
workerPath: WORKER_PATH,
corePath: CORE_PATH,
langPath: LANG_BASE,
logger,
});


try {
await worker.load();
await worker.loadLanguage(lang);
await worker.initialize(lang);


const { data: { text } } = await worker.recognize(file);
return text ?? '';
} finally {
// 失敗時でも確実に terminate
try { await worker.terminate(); } catch {}
}
}