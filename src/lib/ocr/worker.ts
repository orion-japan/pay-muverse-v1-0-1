// src/lib/ocr/worker.ts
import { createWorker } from 'tesseract.js';

let _worker: any = null;

export async function getWorker(lang = 'jpn') {
  if (_worker) return _worker;
  _worker = await createWorker();        // 引数なし
  await _worker.loadLanguage(lang);
  await _worker.initialize(lang);
  return _worker;
}

export async function configureWorker(
  worker: any,
  {
    psm = '6',
    whitelist,
    dpi = 300,
  }: { psm?: string; whitelist?: string; dpi?: number }
) {
  const params: Record<string, string> = {
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: '1',
    user_defined_dpi: String(dpi),
  };
  if (whitelist) params.tessedit_char_whitelist = whitelist;
  await worker.setParameters(params);
}
