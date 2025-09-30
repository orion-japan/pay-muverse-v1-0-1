'use client';

import { useState, ChangeEvent } from 'react';
import SafeImage from '@/components/common/SafeImage';

type Props = {
  /** 受け取った File をアップロードする関数（任意） */
  onUpload?: (file: File) => Promise<void> | void;
  className?: string;
};

export default function ImageUploadComponent({ onUpload, className }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [uploading, setUploading] = useState(false);

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setPreviewUrl(f ? URL.createObjectURL(f) : '');
  }

  async function handleUpload() {
    if (!file || !onUpload) return;
    setUploading(true);
    try {
      await onUpload(file);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className={className}>
      <input type="file" onChange={handleFileChange} accept="image/*" />
      {previewUrl && (
        <SafeImage
          src={previewUrl}
          alt="preview"
          aspectRatio="1/1"
          className="upload-preview"
        />
      )}
      <button onClick={handleUpload} disabled={uploading || !file}>
        {uploading ? 'アップロード中…' : 'アップロード'}
      </button>
    </div>
  );
}
