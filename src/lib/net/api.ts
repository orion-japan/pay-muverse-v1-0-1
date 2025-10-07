// src/lib/net/api.ts

// 既存の export があれば残したままでOK
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/**
 * サイン→アップロード→公開URL取得までを 1 ファイルずつ実行
 * /api/upload/sign が { ok, uploadUrl, publicUrl } を返す前提
 *  - uploadUrl には FormData で "file" を POST（filename 必須）
 *  - 別形式（PUT + headers）にも一応対応
 */
export async function uploadAllImages(files: File[]): Promise<string[]> {
  const urls: string[] = [];

  for (const file of files) {
    // 1) 署名の取得
    const signRes = await fetch('/api/upload/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name || 'upload.png',
        contentType: file.type || 'application/octet-stream',
      }),
      credentials: 'include',
    });

    const signJson = await signRes.json().catch(() => ({}));
    if (!signRes.ok || !signJson?.ok) {
      throw new Error(signJson?.error || 'sign failed');
    }

    // 2) 実アップロード（2パターン対応）
    if (signJson.uploadUrl) {
      // a) 署名URLへ multipart/form-data で file を POST
      const fd = new FormData();
      fd.append('file', file, file.name || 'upload.png');
      const up = await fetch(signJson.uploadUrl as string, { method: 'POST', body: fd });
      if (!up.ok) throw new Error(`upload failed: ${up.status}`);
      urls.push(String(signJson.publicUrl || signJson.public_url));
    } else if (signJson.url) {
      // b) 署名URLへ PUT（ヘッダ同梱式）
      const up = await fetch(signJson.url as string, {
        method: 'PUT',
        headers: signJson.headers || { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!up.ok) throw new Error(`upload failed: ${up.status}`);
      urls.push(String(signJson.publicUrl || signJson.public_url));
    } else {
      throw new Error('invalid sign response');
    }
  }

  return urls;
}
