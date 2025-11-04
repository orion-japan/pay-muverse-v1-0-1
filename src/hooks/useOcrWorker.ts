'use client';
import { useEffect, useMemo, useRef, useState } from 'react';

type OcrJobIn = { file: File; index: number };
type OcrProgress = { running: boolean; current: number; total: number };

export function useOcrWorker() {
  const workerRef = useRef<Worker | null>(null);
  const [progress, setProgress] = useState<OcrProgress>({ running: false, current: 0, total: 0 });

  useEffect(() => {
    workerRef.current = new Worker(new URL('../workers/ocrWorker.ts', import.meta.url), {
      type: 'module',
    });
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  async function run(files: File[], onText: (idx: number, text: string) => void) {
    if (!workerRef.current || files.length === 0) return;
    setProgress({ running: true, current: 0, total: files.length });

    for (let i = 0; i < files.length; i++) {
      const ab = await files[i].arrayBuffer();
      const id = crypto.randomUUID();

      const text = await new Promise<string>((resolve) => {
        const handler = (ev: MessageEvent<any>) => {
          if (ev.data?.id !== id) return;
          workerRef.current?.removeEventListener('message', handler);
          resolve(ev.data?.text || '');
        };
        workerRef.current!.addEventListener('message', handler);
        workerRef.current!.postMessage({ id, file: ab, index: i });
      });

      setProgress((p) => ({ ...p, current: i + 1 }));
      onText(i, text);
    }

    setProgress({ running: false, current: 0, total: 0 });
  }

  return { run, progress };
}
