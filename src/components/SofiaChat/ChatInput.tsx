'use client';

import { useRef, useState } from 'react';
import './ChatInput.css';
type Props = {
  onSend: (text: string, files: File[] | null) => Promise<{ conversation_id?: string }>;
  onPreview: (files: File[], previewUrl: string) => void;
  onCancelPreview: () => void;
};

export default function ChatInput({ onSend, onPreview, onCancelPreview }: Props) {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<File[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleSend() {
    const res = await onSend(value, files);
    setValue('');
    setFiles(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const fs = e.target.files ? Array.from(e.target.files) : [];
    if (!fs.length) return;
    setFiles(fs);

    // 1枚目だけサムネプレビュー（必要に応じて複数対応へ）
    const first = fs[0];
    const url = URL.createObjectURL(first);
    onPreview(fs, url);
  }

  return (
    <div className="sof-compose">
      <input
        className="sof-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="メッセージを入力…"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="sof-file"
        onChange={handleFile}
      />
      <button className="sof-btn primary" onClick={handleSend}>送信</button>
      {files?.length ? (
        <button className="sof-btn" onClick={() => { setFiles(null); onCancelPreview(); if (fileRef.current) fileRef.current.value=''; }}>
          画像クリア
        </button>
      ) : null}
    </div>
  );
}
