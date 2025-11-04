'use client';

import React, { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type Props = {
  userId: string; // FirebaseのUIDやuser_codeなど
  postId: string; // 投稿ID（またはDate.now()でもOK）
};

export default function ImageUploadComponent({ userId, postId }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [privateUrl, setPrivateUrl] = useState<string | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));

    // 非公開バケットにアップロード
    const filename = `${userId}/${Date.now()}.png`;
    const { error } = await supabase.storage
      .from('private-posts')
      .upload(filename, selected, { upsert: true });
    if (error) {
      console.error('Upload failed', error);
      return;
    }

    // 署名付きURL（1時間有効）
    const { data: signed } = await supabase.storage
      .from('private-posts')
      .createSignedUrl(filename, 60 * 60);
    if (signed?.signedUrl) {
      setPrivateUrl(signed.signedUrl);
    }
  };

  const handlePost = async () => {
    if (!file) return;
    setUploading(true);

    const filename = `${postId}/${Date.now()}.png`;
    const { error } = await supabase.storage
      .from('public-posts')
      .upload(filename, file, { upsert: true });
    if (error) {
      console.error('Public upload failed', error);
      setUploading(false);
      return;
    }

    const { data: urlData } = supabase.storage.from('public-posts').getPublicUrl(filename);
    setPublicUrl(urlData?.publicUrl || null);
    console.log('投稿URL:', urlData?.publicUrl);

    setUploading(false);
  };

  return (
    <div className="p-4 border rounded-md max-w-md">
      <h2 className="text-lg font-bold mb-2">画像アップロード</h2>
      <input type="file" accept="image/*" onChange={handleFileChange} />
      {previewUrl && (
        <div className="mt-4">
          <img src={previewUrl} alt="Preview" className="w-48 rounded-md" />
        </div>
      )}
      {privateUrl && (
        <p className="text-sm mt-2">
          🔒 ダウンロードURL（自分専用）:
          <a
            href={privateUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 underline"
          >
            ここ
          </a>
        </p>
      )}
      {file && (
        <button
          onClick={handlePost}
          disabled={uploading}
          className="mt-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          {uploading ? 'アップロード中...' : '投稿として公開'}
        </button>
      )}
      {publicUrl && (
        <p className="text-sm mt-2 text-green-700">
          🌍 公開URL:
          <a href={publicUrl} target="_blank" rel="noopener noreferrer" className="underline">
            {publicUrl}
          </a>
        </p>
      )}
    </div>
  );
}
