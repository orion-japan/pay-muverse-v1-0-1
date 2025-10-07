/* src/components/mui/useOcrPipeline.ts */
'use client';

import { useCallback, useMemo, useState } from 'react';

// ここがポイント：lib/ocr を指す
// エイリアスがある場合
import type { OcrPipelineOptions, OcrResult } from '@/lib/ocr/types';
import { runOcrPipeline } from '@/lib/ocr/ocrPipeline';

// エイリアスが無い場合は ↓ に置き換えてください
// import type { OcrPipelineOptions, OcrResult } from '../../lib/ocr/types';
// import { runOcrPipeline } from '../../lib/ocr/ocrPipeline';

export function useOcrPipeline() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ page: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OcrResult | null>(null);

  const runOcr = useCallback(async (files: File[], opts: OcrPipelineOptions = {}) => {
    if (!files?.length) return null;
    setRunning(true);
    setError(null);
    setProgress({ page: 0, total: files.length });
    try {
      const r = await runOcrPipeline(files, opts);
      setResult(r);
      setProgress({ page: files.length, total: files.length });
      return r;
    } catch (e: any) {
      setError(e?.message ?? 'OCR に失敗しました');
      return null;
    } finally {
      setRunning(false);
    }
  }, []);

  return useMemo(
    () => ({ runOcr, running, progress, error, result }),
    [runOcr, running, progress, error, result]
  );
}

export default useOcrPipeline;
