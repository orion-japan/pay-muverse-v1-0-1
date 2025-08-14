'use client';

import React, { useState } from 'react';
import { uploadAvatar } from '@/lib/uploadAvatar';
import { updateUserAvatarUrl } from '@/lib/updateUserAvatarUrl';

export default function ImageUploadComponent() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0] || null;
    setFile(selectedFile);
    if (selectedFile) {
      setPreviewUrl(URL.createObjectURL(selectedFile));
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setMessage('');

    try {
      const filePath = await uploadAvatar(file);
      const publicUrl = await updateUserAvatarUrl(filePath);
      setMessage('✅ アップロード成功！');
      setPreviewUrl(publicUrl); // 確認用に表示
    } catch (err: any) {
      setMessage(`❌ エラー: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <input type="file" onChange={handleFileChange} accept="image/*" />
      {previewUrl && <img src={previewUrl} alt="プレビュー" width={150} />}
      <button onClick={handleUpload} disabled={uploading}>
        {uploading ? 'アップロード中…' : 'アップロード'}
      </button>
      {message && <p>{message}</p>}
    </div>
  );
}
