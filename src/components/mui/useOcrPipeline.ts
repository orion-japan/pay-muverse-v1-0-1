/* src/components/mui/useOcrPipeline.ts */
'use client';

import { useCallback, useMemo, useState } from 'react';

// ここがポイント：lib/ocr を指す
// エイリアスがある場合
import type { OcrPipelineOptions, OcrResult as BaseOcrResult } from '@/lib/ocr/types';
import { runOcrPipeline } from '@/lib/ocr/ocrPipeline';

// エイリアスが無い場合は ↓ に置き換えてください
// import type { OcrPipelineOptions, OcrResult as BaseOcrResult } from '../../lib/ocr/types';
// import { runOcrPipeline } from '../../lib/ocr/ocrPipeline';

/** 既存の OcrResult 型を壊さずに、UIが欲しいフィールドを補強した「正規化後の型」 */
export type OcrResult = BaseOcrResult & {
  text: string; // ← UIが参照する確定フィールド
  pages?: { text?: string; [k: string]: any }[];
  [k: string]: any;
};

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
      // ライブラリの戻り値は実装差があるため any で受け、ここで正規化
      const raw: BaseOcrResult & { text?: string; plainText?: string; fullText?: string; pages?: any } =
        (await runOcrPipeline(files, opts)) as any;

      const normalized: OcrResult = {
        ...((raw as unknown) as BaseOcrResult),
        text: raw?.text ?? raw?.plainText ?? raw?.fullText ?? '',
        pages: (raw as any)?.pages ?? [],
      };

      setResult(normalized);
      setProgress({ page: files.length, total: files.length });
      return normalized;
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
