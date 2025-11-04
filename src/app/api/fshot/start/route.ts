// src/app/api/fshot/start/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createWorker } from 'tesseract.js';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);

const json = (d: any, s = 200) =>
  new NextResponse(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = (form.get('file') || form.get('image')) as Blob | null;
    if (!file) return json({ ok: false, error: 'no file (file|image)' }, 400);

    const buf = Buffer.from(await file.arrayBuffer());

    // 1) node_modules の実ファイルパスを取得
    //    ※ tesseract.js-core は `npm i tesseract.js-core` 済みであること
    const workerFsPath = require.resolve('tesseract.js/src/worker-script/node/index.js'); // ← Node用
    const coreFsPath = require.resolve('tesseract.js-core/tesseract-core.wasm.js');

    // 2) Windowsでも有効な file:// 絶対URLへ変換（超重要）
    const workerPath = pathToFileURL(workerFsPath).href;
    const corePath = pathToFileURL(coreFsPath).href;

    // デバッグ：実際に渡すURLを確認（1回見えればOK）
    console.log('[OCR] workerPath:', workerPath);
    console.log('[OCR] corePath  :', corePath);

    // 3) 型定義が workerPath/corePath を知らないため any で回避
    const worker = await (createWorker as any)({
      workerPath,
      corePath,
      workerBlobURL: false, // Nodeでは blob:を使わない
      // langPath: 'https://tessdata.projectnaptha.com/4.0.0', // 日本語使うなら有効化
      // logger: (m: any) => console.log('[OCR]', m),
    });

    // 4) 言語選択（日本語を含めるなら 'jpn+eng'）
    await worker.reinitialize('eng');

    const { data } = await worker.recognize(buf);
    await worker.terminate();

    const text = (data?.text || '').trim();
    if (!text) return json({ ok: false, error: 'empty text' }, 422);

    return json({ ok: true, text });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'ocr failed' }, 500);
  }
}
