import { compressImage } from '@/lib/media/compressImage';

const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function signedUpload(file: File, opts?: { prefix?: string }) {
  // 署名取得（filename + prefix）
  const signRes = await fetch('/api/upload/sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ filename: file.name, prefix: opts?.prefix }),
  });
  const sign = await signRes.json();
  if (!signRes.ok || !sign?.ok) throw new Error(sign?.error || 'sign failed');

  // デバッグ確認（DevToolsでURLに <bucket> が含まれているか見る）
  // console.debug('uploadUrl:', sign.uploadUrl);

  // 軽量化
  const slim = await compressImage(file, 1280, 0.8);

  // 返ってきた uploadUrl に token + file を送る（URLは組み立て直さない）
  const fd = new FormData();
  fd.append('token', sign.token as string);
  fd.append('file', slim, slim.name);

  const put = await fetch(sign.uploadUrl as string, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ANON}`, apikey: ANON },
    body: fd,
  });
  if (!put.ok) {
    const t = await put.text().catch(() => '');
    throw new Error(`upload failed: ${put.status} ${t}`);
  }
  return { path: sign.path as string, publicUrl: sign.publicUrl as string | undefined };
}
