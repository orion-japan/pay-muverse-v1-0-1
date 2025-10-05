'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type ChatRole = 'user' | 'assistant';
type Msg = { role: ChatRole; content: string };

// /api/agent/mui の返却想定（幅広く受ける）
type MuiApiOk = {
  ok: true;
  reply: string;
  conversation_code?: string | null;
  balance?: number | null;
};
type MuiApiNg = { ok: false; error: string };
type MuiApiRes = MuiApiOk | MuiApiNg | Record<string, any>;

/* ========= ユーティリティ ========= */
function cleanOcrText(raw: string) {
  return raw
    .replace(/\u3000/g, ' ') // 全角スペース → 半角
    .replace(/[ \t]{2,}/g, ' ') // 連続空白を1つに
    .replace(/([、。！？”」）\]\}])\s+/g, '$1') // 句読点の直後の不要空白
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n') // 3つ以上の空行 → 2つ
    .trim();
}

function revokeAllImageUrls(urls: string[]) {
  urls.forEach((u) => URL.revokeObjectURL(u));
}

/* ========= 画面 ========= */
export default function MuiChatPage() {
  // --- チャット状態 ---
  const [input, setInput] = useState('');
  const [conv, setConv] = useState<Msg[]>([]);
  const [sending, setSending] = useState(false);
  const [convCode, setConvCode] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 入力欄のDOM参照（送信後に確実クリア用）
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // --- ユーザーコード（window変数経由 or ANON） ---
  const userCode: string =
    (typeof window !== 'undefined' && (window as any).__USER_CODE__) || 'ANON';

  // --- 画像／OCR（複数） ---
  const MAX_FILES = 5;
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrIndex, setOcrIndex] = useState<number | null>(null); // 何枚目をOCR中か
  const dropRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 並び替え用（ドラッグ移動の開始位置）
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const canSend = useMemo(() => !!input.trim() && !sending, [input, sending]);

  /* ===== 画像URLクリーンアップ ===== */
  useEffect(() => {
    return () => revokeAllImageUrls(imageUrls);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ===== ファイル追加（input/drag共通） ===== */
  const addFiles = useCallback(
    (files: FileList | File[] | null | undefined) => {
      if (!files) return;
      const arr = Array.from(files).slice(0, MAX_FILES - imageFiles.length);
      if (arr.length === 0) return;

      const combined = [...imageFiles, ...arr].slice(0, MAX_FILES);

      // URLを作り直す（メモリリーク防止）
      revokeAllImageUrls(imageUrls);
      const urls = combined.map((f) => URL.createObjectURL(f));

      setImageFiles(combined);
      setImageUrls(urls);
    },
    [imageFiles, imageUrls]
  );

  const onPickImageClick = useCallback(() => fileInputRef.current?.click(), []);
  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      addFiles(e.target.files || undefined);
      // 同じ選択だと change が走らない対策
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [addFiles]
  );

  // D&D（領域への追加）
  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      addFiles(e.dataTransfer?.files || undefined);
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();

    el.addEventListener('drop', onDrop);
    el.addEventListener('dragover', onDragOver);
    return () => {
      el.removeEventListener('drop', onDrop);
      el.removeEventListener('dragover', onDragOver);
    };
  }, [dropRef, addFiles]);

  /* ===== 並び替え ===== */
  function moveImage(from: number, to: number) {
    if (to < 0 || to >= imageFiles.length || from === to) return;
    const nf = [...imageFiles];
    const file = nf.splice(from, 1)[0];
    nf.splice(to, 0, file);

    revokeAllImageUrls(imageUrls);
    const nu = nf.map((f) => URL.createObjectURL(f));
    setImageFiles(nf);
    setImageUrls(nu);
  }
  function removeImage(idx: number) {
    const nf = imageFiles.filter((_, i) => i !== idx);
    revokeAllImageUrls(imageUrls);
    const nu = nf.map((f) => URL.createObjectURL(f));
    setImageFiles(nf);
    setImageUrls(nu);
  }
  function clearImages() {
    setImageFiles([]);
    revokeAllImageUrls(imageUrls);
    setImageUrls([]);
  }

  // D&D 並び替え（各カード）
  const onItemDragStart = useCallback((i: number) => setDragFrom(i), []);
  const onItemDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => e.preventDefault(),
    []
  );
  const onItemDrop = useCallback(
    (i: number) => {
      if (dragFrom === null || dragFrom === i) return;
      moveImage(dragFrom, i);
      setDragFrom(null);
    },
    [dragFrom]
  );
  const onItemDragEnd = useCallback(() => setDragFrom(null), []);

  /* ===== OCR（tesseract.js v4/v5 両対応） ===== */
  const runOCR = useCallback(async () => {
    if (imageFiles.length === 0) return;
    setOcrRunning(true);
    setOcrIndex(0);
    setError(null);

    try {
      const T = await import('tesseract.js');
      const lang = 'jpn+eng';

      for (let i = 0; i < imageFiles.length; i++) {
        setOcrIndex(i + 1);

        const f = imageFiles[i];
        const buf = await f.arrayBuffer();

        let text = '';
        if (typeof (T as any).createWorker === 'function') {
          const worker: any = await (T as any).createWorker();
          if (
            typeof worker.loadLanguage === 'function' &&
            typeof worker.initialize === 'function'
          ) {
            await worker.loadLanguage(lang);
            await worker.initialize(lang);
          } else if (typeof worker.reinitialize === 'function') {
            await worker.reinitialize(lang);
          }
          const r = await worker.recognize(Buffer.from(buf));
          await worker.terminate?.();
          text = cleanOcrText((r?.data?.text || '').trim());
        } else {
          const r = await (T as any).recognize(Buffer.from(buf), lang);
          text = cleanOcrText((r?.data?.text || '').trim());
        }

        if (!text) {
          // 空でも次へ（全体が止まるのを避ける）
          continue;
        }

        // 入力欄へ番号付きで追記
        const numbered = `【#${i + 1}】\n${text}`;
        setInput((prev) => (prev ? prev + '\n\n' + numbered : numbered));

        // Supabase 保存（失敗は warn のみに）
        try {
          const fd = new FormData();
          fd.append('ocr_text', text);
          fd.append('user_code', userCode);
          if (convCode) fd.append('conversation_code', convCode);
          fd.append('index', String(i + 1));
          fd.append('file', f, f.name || `upload-${i + 1}.png`);
          const res = await fetch('/api/fshot/save', {
            method: 'POST',
            body: fd,
            credentials: 'include',
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j?.ok) console.warn('save failed', j);
        } catch (ee) {
          console.warn('save error', ee);
        }
      }
    } catch (e: any) {
      setError(e?.message || 'OCRに失敗しました');
    } finally {
      setOcrRunning(false);
      setOcrIndex(null);
    }
  }, [imageFiles, convCode, userCode]);

  /* ===== 送信処理 ===== */
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setError(null);

    // UI反映（自分の発言）
    setConv((prev) => [...prev, { role: 'user', content: text }]);
    setInput(''); // state を空に
    if (textareaRef.current) {
      textareaRef.current.value = ''; // DOM も確実に空に
      // textareaRef.current.blur(); // モバイルでキーボードを閉じたい場合は有効化
    }

    try {
      // user_code を確実に届ける：クエリ + ボディ + ヘッダー
      const url = `/api/agent/mui?user_code=${encodeURIComponent(userCode)}`;
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Code': userCode,
        },
        body: JSON.stringify({
          text,
          conversation_code: convCode,
          user_code: userCode,
        }),
      });

      const data: MuiApiRes = await res
        .json()
        .catch(() => ({ ok: false, error: 'Invalid JSON' }));

      if (!res.ok || (data as any)?.ok === false) {
        throw new Error((data as any)?.error || 'Mui API error');
      }

      const reply = (data as any).reply ?? (data as any).message ?? '';
      const newCode =
        (data as any).conversation_code ?? (data as any).conv_code ?? null;
      const newBal =
        typeof (data as any).balance === 'number'
          ? (data as any).balance
          : typeof (data as any).credit === 'number'
          ? (data as any).credit
          : null;

      if (newCode) setConvCode(String(newCode));
      if (typeof newBal === 'number') setBalance(newBal);

      setConv((prev) => [
        ...prev,
        { role: 'assistant', content: String(reply || '…') },
      ]);
    } catch (e: any) {
      setError(e?.message || '送信に失敗しました');
    } finally {
      setSending(false);
    }
  }, [input, sending, convCode, userCode]);

  // ===== キー送信 =====
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send();
    },
    [send]
  );

  /* ========= UI ========= */
  return (
    <div className="mui-root">
      <header className="mui-header">
        <div className="left">
          <h1 className="mui-title">Mui — 恋愛相談</h1>
          <p className="sub">
            会話コード: {convCode ?? '—'} / 残高: {balance ?? '—'}
          </p>
        </div>
        <div className="right">
          <button className="ghost" onClick={onPickImageClick} disabled={ocrRunning}>
            画像を選ぶ
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={onFileChange}
            style={{ display: 'none' }}
          />
          <button
            className="primary"
            onClick={runOCR}
            disabled={imageFiles.length === 0 || ocrRunning}
          >
            {ocrRunning
              ? `OCR中… (${ocrIndex ?? 0}/${imageFiles.length})`
              : 'OCRで読み取る'}
          </button>
        </div>
      </header>

      <section ref={dropRef} className="dropzone">
        {imageUrls.length ? (
          <div className="preview-grid">
            {imageUrls.map((url, i) => (
              <div
                className={`preview-item ${dragFrom === i ? 'dragging' : ''}`}
                key={i}
                draggable
                onDragStart={() => onItemDragStart(i)}
                onDragOver={onItemDragOver}
                onDrop={() => onItemDrop(i)}
                onDragEnd={onItemDragEnd}
                aria-label={`画像${i + 1}（ドラッグで並び替え）`}
              >
                <div className="thumb">
                  <span className="badge">#{i + 1}</span>
                  <img src={url} alt={`preview-${i + 1}`} />
                </div>
                <div className="meta">
                  <span className="name">{imageFiles[i]?.name}</span>
                  <span className="size">
                    {imageFiles[i] ? `(${(imageFiles[i].size / 1024).toFixed(0)} KB)` : ''}
                  </span>
                </div>
                <div className="preview-actions">
                  <button
                    className="tiny"
                    onClick={() => moveImage(i, i - 1)}
                    disabled={i === 0}
                    aria-label="一つ上へ"
                  >
                    ↑
                  </button>
                  <button
                    className="tiny"
                    onClick={() => moveImage(i, i + 1)}
                    disabled={i === imageFiles.length - 1}
                    aria-label="一つ下へ"
                  >
                    ↓
                  </button>
                  <button className="tiny" onClick={() => removeImage(i)} aria-label="削除">
                    削除
                  </button>
                </div>
              </div>
            ))}
            <div className="preview-toolbar">
              <button
                className="tiny ghost"
                onClick={onPickImageClick}
                disabled={imageFiles.length >= MAX_FILES}
              >
                追加（最大{MAX_FILES}枚）
              </button>
              <button className="tiny" onClick={clearImages} disabled={!imageFiles.length}>
                すべて削除
              </button>
            </div>
          </div>
        ) : (
          <div className="drop-hint">
            <strong>ここにLINEスクショをドロップ（最大{MAX_FILES}枚）</strong>
            <span>または右上の「画像を選ぶ」からアップロード</span>
          </div>
        )}
      </section>

      <main className="chat">
        {conv.length === 0 ? (
          <div className="empty">ここに会話が表示されます</div>
        ) : (
          conv.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              <div className="role">{m.role === 'user' ? 'あなた' : 'Mui'}</div>
              <div className="content">{m.content}</div>
            </div>
          ))
        )}
      </main>

      <footer className="composer">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            imageFiles.length
              ? 'OCRで読み取った文章を確認して、Ctrl/Cmd + Enterで送信'
              : 'ここに相談内容を書くか、スクショをOCRで読み取って相談を始める'
          }
        />
        <div className="actions">
          <button className="primary" onClick={send} disabled={!canSend}>
            {sending ? '送信中…' : '送信'}
          </button>
        </div>
      </footer>

      {error && <div className="error">{error}</div>}

      {/* ====== CSS ====== */}
      <style jsx global>{`
        html,
        body {
          margin: 0;
          padding: 0;
          background: #0b1437;
          overflow-x: hidden;
        }
      `}</style>

      <style jsx>{`
        .mui-root {
          --bg: #0b1437;
          --panel: #111a3f;
          --panel2: #132151;
          --text: #e8ecff;
          --sub: #b8c0e8;
          --accent: #7c8cff;
          --ok: #61d6a7;
          --danger: #ff6b88;

          min-height: 100vh;
          background: radial-gradient(1200px 600px at 20% -10%, #1a255a 0%, #0b1437 60%) no-repeat,
            var(--bg);
          color: var(--text);
          padding: 16px;
          box-sizing: border-box;
        }

        /* 見出し（上）＋ボタン（下） */
        .mui-header {
          display: grid;
          grid-template-areas:
            'title'
            'buttons';
          align-items: start;
          gap: 10px;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.02));
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 14px;
          padding: 12px 14px;
          margin-bottom: 12px;
        }
        .mui-header .left {
          grid-area: title;
        }
        .mui-header .right {
          grid-area: buttons;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr)); /* 2ボタンを同幅に */
          gap: 8px;
          width: 100%;
          max-width: 360px;
          justify-self: start;
        }
        .mui-header .right button {
          width: 100%;
          padding: 10px 0;
          display: flex;
          align-items: center;
          justify-content: center;
          white-space: nowrap;
        }

        .mui-title {
          font-size: 18px;
          font-weight: 600;
          margin: 0;
          color: var(--text);
          letter-spacing: 0.5px;
          line-height: 1.4;
        }
        .sub {
          margin: 2px 0 0;
          color: var(--sub);
          font-size: 12px;
        }

        button {
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: rgba(255, 255, 255, 0.06);
          color: var(--text);
          border-radius: 10px;
          padding: 8px 12px;
          cursor: pointer;
          font-size: 14px;
        }
        button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        button.primary {
          border-color: var(--accent);
        }
        button.ghost {
          background: transparent;
        }
        button.tiny {
          padding: 4px 8px;
          font-size: 12px;
          border-radius: 8px;
        }

        .dropzone {
          margin-bottom: 12px;
          border: 1px dashed rgba(255, 255, 255, 0.18);
          border-radius: 14px;
          min-height: 140px;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 10px;
          background: var(--panel2);
        }
        .drop-hint {
          text-align: center;
          color: var(--sub);
          display: grid;
          gap: 6px;
        }

        /* === 画像一覧：常に2列、中央寄せ === */
        .preview-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 10px;
          max-width: 620px;
          width: 100%;
          margin: 0 auto;
        }

        .preview-item {
          display: grid;
          gap: 6px;
          background: rgba(0, 0, 0, 0.15);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 12px;
          padding: 8px;
          transition: opacity 0.15s ease, transform 0.15s ease, outline-color 0.15s ease;
          min-width: 0;
        }
        .preview-item.dragging {
          opacity: 0.6;
        }
        .preview-item:hover {
          outline: 1px dashed rgba(255, 255, 255, 0.35);
        }
        .thumb {
          position: relative;
        }
        .thumb img {
          width: 100%;
          height: 120px; /* 必要なら 100px/90px に */
          object-fit: cover;
          border-radius: 8px;
          background: #000;
          display: block;
        }
        .badge {
          position: absolute;
          top: 6px;
          left: 6px;
          background: rgba(0, 0, 0, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.2);
          font-size: 12px;
          padding: 2px 6px;
          border-radius: 999px;
        }
        .meta {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          color: var(--sub);
          font-size: 12px;
          min-width: 0;
        }
        .name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 70%;
        }
        .preview-actions {
          display: flex;
          gap: 6px;
          justify-content: flex-end;
        }
        .preview-toolbar {
          grid-column: 1 / -1;
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }

        .chat {
          display: grid;
          gap: 10px;
          background: var(--panel);
          border-radius: 14px;
          padding: 12px;
          min-height: 280px;
          max-height: 55vh;
          overflow: auto;
        }
        .empty {
          color: var(--sub);
          text-align: center;
          padding: 20px 0;
        }
        .bubble {
          display: grid;
          gap: 6px;
          padding: 10px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.03);
        }
        .bubble.assistant {
          background: rgba(124, 140, 255, 0.08);
        }
        .bubble .role {
          font-size: 12px;
          color: var(--sub);
        }
        .bubble .content {
          white-space: pre-wrap;
          line-height: 1.6;
        }

        .composer {
          display: grid;
          gap: 8px;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.02));
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 14px;
          padding: 12px;
          margin-top: 12px;
        }
        .composer textarea {
          width: 100%;
          min-height: 90px;
          resize: vertical;
          color: var(--text);
          background: rgba(0, 0, 0, 0.15);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 10px;
          padding: 10px;
        }

        .actions {
          display: flex;
          justify-content: flex-end;
        }
        .error {
          margin-top: 10px;
          color: var(--danger);
        }
      `}</style>
    </div>
  );
}
