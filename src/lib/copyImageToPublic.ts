// src/lib/copyImageToPublic.ts
export async function copyImageToPublic(
  originalUrl: string,
  userCode: string
): Promise<string | null> {
  console.log('========== [copyImageToPublic - API経由] START ==========');
  console.log('[📥 入力値]', { originalUrl, userCode });

  try {
    if (!originalUrl?.trim() || !userCode?.trim()) {
      console.error('[❌ 必須パラメータ不足]', { originalUrl, userCode });
      return null;
    }

    // ✅ 無限ループ防止：すでに public-posts にある画像ならそのまま返す
    if (
      originalUrl.includes('/public-posts/') ||
      originalUrl.includes('supabase.co/storage/v1/object/public/')
    ) {
      console.warn('[⚠️ すでにpublic-postsの画像のため再コピーしません]');
      return originalUrl;
    }

    // ✅ ファイル名抽出（トークン除去）
    const filePart = originalUrl.split('/').pop()?.split('?')[0];
    const rawName = decodeURIComponent(filePart || '').replace(/\s+/g, '_');

    if (!rawName) {
      console.error('[❌ ファイル名抽出失敗]', originalUrl);
      return null;
    }

    const ext = rawName.includes('.') ? rawName.split('.').pop() : 'png';
    const safeFileName = `${Date.now()}_${Math.floor(Math.random() * 100000)}.${ext}`;

    console.log('[📡 画像取得開始]', rawName);

    const response = await fetch(originalUrl);
    if (!response.ok) {
      console.error('[❌ fetch失敗]', {
        status: response.status,
        statusText: response.statusText,
        url: originalUrl,
      });
      return null;
    }

    const blob = await response.blob();
    console.log('[📦 Blob取得成功]', { size: blob.size, type: blob.type });

    const arrayBuffer = await blob.arrayBuffer();
    let base64Data: string;

    if (typeof window !== 'undefined') {
      const binary = String.fromCharCode(...new Uint8Array(arrayBuffer));
      base64Data = btoa(binary);
    } else {
      base64Data = Buffer.from(arrayBuffer).toString('base64');
    }

    console.log('[📤 API経由アップロード開始]');

    const apiRes = await fetch('/api/upload-public-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: safeFileName,
        fileData: base64Data,
        userCode,
        contentType: blob.type || 'application/octet-stream',
      }),
    });

    if (!apiRes.ok) {
      console.error('[❌ APIアップロード失敗]', {
        status: apiRes.status,
        text: await apiRes.text().catch(() => '(取得不可)'),
      });
      return null;
    }

    const json = await apiRes.json().catch(() => null);
    if (!json?.publicUrl) {
      console.error('[❌ publicUrl未取得]', json);
      return null;
    }

    console.log('[✅ API経由アップロード成功]', json.publicUrl);
    return json.publicUrl;
  } catch (error) {
    console.error('[❌ 予期せぬエラー]', error);
    return null;
  }
}
