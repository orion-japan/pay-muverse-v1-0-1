// src/lib/ocr/useOcrPipeline.ts
'use client';

import { useCallback, useState } from 'react';
import { runOcrWithTesseract, type OcrProgress } from '@/lib/ocr/runOcrWithTesseract';

export function useOcrPipeline() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onProg = useCallback((m: OcrProgress) => {
    if (typeof m?.progress === 'number') setProgress(m.progress);
  }, []);

  const runOcr = useCallback(async (file: File, lang: string = 'jpn') => {
    if (!file) return '';
    setRunning(true);
    setError(null);
    setProgress(0);
    setText('');
    try {
      const t = await runOcrWithTesseract(file, lang, onProg);
      setText(t);
      return t;
    } catch (e: any) {
      setError(e?.message ?? 'OCR failed');
      throw e;
    } finally {
      setRunning(false);
    }
  }, [onProg]);

  return { running, progress, text, error, runOcr };
}
