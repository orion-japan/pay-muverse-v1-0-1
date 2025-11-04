'use client';

import React, { useCallback, useRef, useState } from 'react';
import { runOcrPipeline } from '@/lib/ocr/ocrPipeline';
import { postprocessOcr } from '@/lib/ocr/postprocess';

type EditorProps = { initial?: string };

export default function MuiOcrPanel({ initial = '' }: EditorProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<string>(initial); // ← 本文のみ
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 画像選択
  const onPick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFiles(Array.from(e.target.files ?? []));
  }, []);

  // OCR →（軽整形）→ AI整形 → 本文へ反映（※プレビュー無し）
  const handleOcrAndApply = useCallback(async () => {
    if (!files.length || busy) return;
    setBusy(true);
    try {
      // 1) OCR
      const r = await runOcrPipeline(files); // 画像→テキスト（pages/rawText）
      // 2) 軽整形（句読点/字間など）
      const base = postprocessOcr(r.rawText || '');
      // 3) AI整形（A/B付与・◎補完・誤字の軽修正・文割）
      const ai = await fetch('/api/ai-format', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: base }),
      }).then((res) => res.text());
      // 4) 本文へ反映 & 自動スクロール
      setEditor(ai);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 0);
    } finally {
      setBusy(false);
    }
  }, [files, busy]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label className="px-3 py-2 rounded-lg bg-white/70 shadow cursor-pointer">
          画像を選ぶ
          <input type="file" accept="image/*" multiple className="hidden" onChange={onPick} />
        </label>

        <button
          className="px-3 py-2 rounded-lg bg-violet-200 shadow disabled:opacity-60"
          onClick={handleOcrAndApply}
          disabled={busy || files.length === 0}
          title="OCR結果をそのままAIに送り、整形文だけ本文へ反映します"
        >
          OCR→AI整形して本文へ反映
        </button>

        {busy && <span className="text-sm opacity-70">処理中…</span>}
      </div>

      {/* プレビューは完全に排除（表示なし） */}

      {/* 本文 */}
      <section className="rounded-xl bg-white p-3 shadow">
        <div className="text-sm font-semibold mb-2">本文</div>
        <textarea
          className="w-full min-h-[320px] resize-vertical outline-none"
          value={editor}
          onChange={(e) => setEditor(e.target.value)}
          placeholder="ここに整形済みの本文が入ります"
        />
        <div id="editor-bottom" ref={bottomRef} />
      </section>
    </div>
  );
}
