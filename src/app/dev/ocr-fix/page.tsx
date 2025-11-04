'use client';

import { useState, useCallback, type ChangeEvent, useRef } from 'react';
import { runOcrWithTesseractV6, type OcrProgress } from '@/lib/ocr/runOcrWithTesseract_v6';

export default function OcrFixPage() {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<OcrProgress>({});
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setText('');
    setError('');
    setProgress({ status: 'initialized', progress: 0 });

    try {
      const out = await runOcrWithTesseractV6(file, 'jpn+eng', (p) => setProgress(p ?? {}));
      setText(out);
    } catch (err: any) {
      console.error('[OCR page] run error:', err);
      setError(err?.message ?? String(err));
    } finally {
      // 同じファイルを連続選択しても onChange が走るように
      if (inputRef.current) inputRef.current.value = '';
    }
  }, []);

  const pct =
    typeof progress.progress === 'number' ? Math.round(progress.progress * 100) : undefined;

  return (
    <main className="p-4">
      <h1 className="text-xl font-bold">OCR Fix</h1>

      <div className="mt-3">
        <label className="mr-2 inline-block font-medium">ファイルを選択</label>
        <input
          ref={inputRef}
          type="file"
          accept="image/*,.jpg,.jpeg,.png,.webp"
          onChange={handleChange}
        />
      </div>

      <p className="mt-2 text-sm text-gray-600">
        progress: {pct !== undefined ? `${pct}%` : '—'}
        <span className="ml-2">({progress.status ?? '—'})</span>
      </p>

      {error && <div className="mt-2 text-sm text-red-600 break-all">{error}</div>}

      <textarea
        className="mt-3 w-full h-64 p-2 border rounded"
        value={text}
        readOnly
        placeholder="ここに結果が表示されます"
      />
    </main>
  );
}
