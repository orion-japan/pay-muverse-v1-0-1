// app/dev/ocr-test/page.tsx
'use client';

import React, { useCallback, useState } from 'react';
import { runOcrWithTesseract, OcrProgress } from '@/lib/ocr/runOcrWithTesseract';

// name を必ず string に正規化（ここで undefined を潰す）
function getFileName(v: unknown): string {
  return typeof v === 'object' && v !== null && 'name' in (v as any)
    ? String((v as any).name ?? '')
    : '';
}

export default function OcrTestPage() {
  const [progress, setProgress] = useState<number>(0);
  const [status, setStatus] = useState<string>('');
  const [text, setText] = useState<string>('');
  const [error, setError] = useState<string>('');

  const onProgress = useCallback((m: OcrProgress) => {
    if (typeof m.progress === 'number') setProgress(Math.round(m.progress * 100));
    if (m.status) setStatus(m.status);
  }, []);

  const handleFile = useCallback(
    async (file: File | null) => {
      setError('');
      setText('');
      setProgress(0);
      setStatus('');
      if (!file) return;

      // ★★★ ここが重要（.endsWith は使わない）
      const name = getFileName(file);
      const isHeic = /\.heic$/i.test(name); // 正規表現なら name が '' でも落ちない
      console.log('[OCR] picked:', { name, type: (file as any).type });

      if (isHeic) {
        setError(
          'HEICはそのままでは失敗する場合があります。PNG/JPEGで試すか、変換してからお試しください。',
        );
      }

      try {
        const result = await runOcrWithTesseract(file, 'jpn+eng', onProgress);
        console.log('[OCR] done, length=', result?.length ?? 0);
        setText(result || '(空)');
      } catch (e: any) {
        console.error('[OCR] error', e);
        setError(e?.message ?? 'OCRでエラーが発生しました');
      }
    },
    [onProgress],
  );

  return (
    <main className="p-4 max-w-screen-sm mx-auto">
      <h1 className="text-xl font-semibold mb-3">OCR Test</h1>

      <label className="inline-flex items-center gap-2 px-3 py-2 rounded bg-gray-100 cursor-pointer hover:bg-gray-200">
        <span>ファイルを選択</span>
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <div className="mt-3 text-sm text-gray-600">
        progress: {progress}% {status && <span>（{status}）</span>}
      </div>

      {error && <div className="mt-2 text-red-600 text-sm break-all">{error}</div>}

      <textarea
        className="mt-3 w-full h-64 p-2 border rounded"
        value={text}
        readOnly
        placeholder="ここに結果が表示されます"
      />
    </main>
  );
}
