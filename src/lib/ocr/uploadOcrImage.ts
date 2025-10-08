// lib/ocr/uploadOcrImage.ts
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

async function fileToCanvasWebP(file: File, maxEdge = 2000, quality = 0.8) {
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await new Promise(res => (img.onload = res));
  const { width, height } = img;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob: Blob = await new Promise(r => canvas.toBlob(b => r(b!), 'image/webp', quality)!);
  return blob;
}

async function sha256OfBlob(blob: Blob) {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function uploadOcrImage(file: File, user_code: string) {
  const supabase = createClientComponentClient();
  const blob = await fileToCanvasWebP(file, 2000, 0.8);
  const sha = await sha256OfBlob(blob);
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const path = `ocr/${user_code}/${yyyy}/${mm}/${sha}.webp`;

  const { error } = await supabase.storage.from('mui-ocr').upload(path, blob, { upsert: false, contentType: 'image/webp' });
  if (error) throw error;
  return { path, sha, widthHeightUnknown: true }; // 必要ならサイズは別採取
}
