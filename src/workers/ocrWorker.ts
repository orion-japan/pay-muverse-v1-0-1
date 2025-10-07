/// <reference lib="webworker" />
// tesseract.js を Worker 内で動かす（1ジョブずつ）
export type OcrJob = { id: string; file: ArrayBuffer; index: number; lang?: string };
export type OcrDone = { id: string; index: number; text: string; error?: string };

let T: any = null;
let workerImpl: any = null;

async function init(lang: string) {
  if (!T) T = await import('tesseract.js');
  if (!workerImpl) {
    workerImpl = await T.createWorker();
    if (workerImpl.loadLanguage && workerImpl.initialize) {
      await workerImpl.loadLanguage(lang);
      await workerImpl.initialize(lang);
    } else if (workerImpl.reinitialize) {
      await workerImpl.reinitialize(lang);
    }
  }
}

self.onmessage = async (ev: MessageEvent<OcrJob>) => {
  const { id, file, index, lang = 'jpn+eng' } = ev.data;
  try {
    await init(lang);
    const r = await workerImpl.recognize(file as any);
    const text = (r?.data?.text || '').trim();
    const msg: OcrDone = { id, index, text };
    (self as any).postMessage(msg);
  } catch (e: any) {
    const msg: OcrDone = { id, index, text: '', error: e?.message || 'ocr failed' };
    (self as any).postMessage(msg);
  }
};
