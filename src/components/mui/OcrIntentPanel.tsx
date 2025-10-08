/* src/components/mui/OcrIntentPanel.tsx */
'use client';

import React, { useCallback, useMemo, useState } from 'react';
import './OcrIntentPanel.css';

import { OCR_PHASE_POLICY, INTENT_CATEGORY_OPTIONS, OCR_INTENT_VIEW } from '@/lib/mui/ocr-intent';
import { createOcrSeed, saveOcrIntent } from '@/lib/mui/api';
import useOcrPipeline, { type OcrResult } from '@/components/mui/useOcrPipeline';

/** 画像アップロード（仮実装）
 *  既にストレージアップロードの仕組みがある場合は差し替えてください。
 *  ここではプレビューURLを返すだけにしています（本番は不要）。
 */
async function uploadFilesToStorage(files: File[]): Promise<string[]> {
  return files.map((f) => URL.createObjectURL(f));
}

type Props = {
  userCode: string;
  /** Stage1-1 へ遷移するハンドラ（既存のUIの方法に合わせて実装） */
  onProceed: (seedId: string) => void;
};

export default function OcrIntentPanel({ userCode, onProceed }: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [intentText, setIntentText] = useState('');
  const [intentCat, setIntentCat] = useState<string>(INTENT_CATEGORY_OPTIONS[0]);
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);

  const { runOcr, running, result, error } = useOcrPipeline();

  const onPick = useCallback((ev: React.ChangeEvent<HTMLInputElement>) => {
    const fs = Array.from(ev.target.files ?? []);
    setFiles(fs);
    setWarn(null);
  }, []);

  const onDrop = useCallback((ev: React.DragEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const fs = Array.from(ev.dataTransfer.files ?? []);
    setFiles(fs);
    setWarn(null);
  }, []);

  const onDragOver = useCallback((ev: React.DragEvent<HTMLDivElement>) => {
    ev.preventDefault();
  }, []);

  const canSubmit = useMemo(() => {
    return !!intentText.trim() && !running && !busy;
  }, [intentText, running, busy]);

  const handleProceed = useCallback(async () => {
    const text = intentText.trim();
    if (!text) return;

    // 入口ガード：この画面では本文に触れない
    if (!OCR_PHASE_POLICY.allowContentTalk && /彼が|既読|未読|返信|言った|スクショ|本文|会話|LINE/i.test(text)) {
      setWarn(OCR_PHASE_POLICY.violationMsg);
      return;
    }

    try {
      setBusy(true);
      setWarn(null);

      // ① OCR 実行（結果は Stage1 で使う。ここでは触れない）
      let ocrText = (result as OcrResult | null | undefined)?.text ?? '';
      if (!ocrText) {
        const r = await runOcr(files, { lang: 'jpn' });
        if (r?.text) ocrText = r.text;
      }

      // ② 画像アップロード（仮実装）
      const imageUrls = files.length ? await uploadFilesToStorage(files) : [];

      // ③ seed 作成（本文は保存のみ）
      const { seed_id } = await createOcrSeed({
        user_code: userCode,
        images: imageUrls,
        ocr_text: ocrText,
        meta: { pageCount: (result as any)?.pages?.length ?? 1 }
      });

      // ④ 意図を保存（本文には触れない）
      await saveOcrIntent({
        user_code: userCode,
        seed_id,
        intent_text: text,
        intent_category: intentCat
      });

      // ⑤ 次へ（Stage1 無料診断へ）
      onProceed(seed_id);
    } catch (e: any) {
      setWarn(e?.message ?? 'エラーが発生しました');
    } finally {
      setBusy(false);
    }
  }, [intentText, intentCat, files, result, runOcr, userCode, onProceed]);

  return (
    <div className="ocr-wrap">
      <div className="ocr-card">
        <h2 className="ocr-title">Mui — 恋愛相談（OCR入口）</h2>
        <p className="ocr-desc">{OCR_INTENT_VIEW.uiText}</p>

        <div className="ocr-upload">
          <label className="ocr-label">スクショ画像</label>
          <input type="file" accept="image/*" multiple onChange={onPick} />
          <div className="ocr-drop" onDrop={onDrop} onDragOver={onDragOver}>
            ここにLINEスクショをドロップ<br/>
            または上の「画像を選ぶ」からアップロード
          </div>
          {files.length > 0 && <div className="ocr-hint">{files.length} 枚を選択中</div>}

          <button className="btn ocr-btn" disabled={running || busy} onClick={() => runOcr(files, { lang: 'jpn' })}>
            {running ? 'OCR中…' : 'OCRで読み取る'}
          </button>

          {!!(result as any)?.pages?.length && (
            <div className="ocr-ok">OCRテキストを保存しました（本文には触れません）</div>
          )}
          {error && <div className="ocr-err">OCRエラー：{error}</div>}
        </div>

        <div className="ocr-intent">
          <label className="ocr-label">あなたの「知りたいこと」（意図）</label>
          <textarea
            className="ocr-textarea"
            rows={3}
            placeholder="例：彼の本音を知りたい／嘘か本当か知りたい／どう返信すれば良い？"
            value={intentText}
            onChange={(e) => setIntentText(e.target.value)}
          />
          <div className="ocr-row">
            <span className="ocr-label">カテゴリ</span>
            <select
              value={intentCat}
              onChange={(e) => setIntentCat(e.target.value)}
              className="ocr-select"
            >
              {INTENT_CATEGORY_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          {warn && <div className="ocr-warn">{warn}</div>}

          <button className="btn go-btn" disabled={!canSubmit} onClick={handleProceed}>
            {busy ? '準備中…' : '無料診断（Stage1）へ'}
          </button>
        </div>

        <div className="ocr-steps">
          <ol>
            <li>スクショをアップ（この画面では本文に触れません）</li>
            <li>「知りたいこと（意図）」を1つだけ入力</li>
            <li>次の画面（Stage1）で無料の初期診断を表示</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
