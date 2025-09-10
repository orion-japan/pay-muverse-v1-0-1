// src/utils/imageResize.ts
export type ResizeOptions = {
  /** 出力の長辺（px）。未指定なら 256 */
  max?: number;
  /** 正方形クロップするか（中央） */
  square?: boolean;
  /** 出力 MIME。未指定なら 'image/png' */
  type?: string; // 'image/webp' | 'image/png' | 'image/jpeg' など
  /** 画質（0〜1）。PNG は無視される */
  quality?: number;
  /** JPEG など非透過形式用の背景（例: '#fff'）*/
  background?: string | null;
};

/** Canvas.toBlob が null を返す Safari 対策のフォールバック */
function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) return resolve(blob);
        try {
          const dataUrl = canvas.toDataURL(type, quality);
          const arr = dataUrl.split(',');
          const mime = arr[0].match(/:(.*?);/)?.[1] || type;
          const bstr = atob(arr[1]);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) u8arr[n] = bstr.charCodeAt(n);
          resolve(new Blob([u8arr], { type: mime }));
        } catch (e) {
          reject(e);
        }
      },
      type,
      quality
    );
  });
}

/**
 * 画像を読み込み、リサイズして Blob を返す
 * - `square: true` の場合は中央で正方形にクロップしてから `max` に収める
 * - それ以外はアスペクト比を維持して長辺を `max` に揃える
 * - 入力より大きくは拡大しない（アップスケール抑止）
 * - 呼び出し側が File でも Blob でも動く
 * - 互換性: もし呼び出しが { maxSize, format } を渡しても内部で解釈する
 */
export async function resizeImage(
  file: File | Blob,
  opts: ResizeOptions = {}
): Promise<Blob> {
  // 互換: maxSize / format が来ても既存構造は維持
  const legacyMax =
    (opts as any).maxSize != null ? Number((opts as any).maxSize) : undefined;
  const legacyType =
    (opts as any).format === 'webp'
      ? 'image/webp'
      : (opts as any).format === 'jpeg'
      ? 'image/jpeg'
      : (opts as any).format === 'png'
      ? 'image/png'
      : undefined;

  const {
    max = legacyMax ?? 256,
    square = false,
    type = legacyType ?? 'image/png',
    quality = 0.92,
    background = null,
  } = opts;

  // 画像読み込み（Blob も受ける）
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });

  // 入力サイズ
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) throw new Error('画像の読み込みに失敗しました');

  // 出力サイズ
  let sw = 0,
    sh = 0,
    sx = 0,
    sy = 0; // ソース側の切り出し
  let dw = 0,
    dh = 0; // 出力キャンバスサイズ

  if (square) {
    const size = Math.min(iw, ih);
    sx = Math.floor((iw - size) / 2);
    sy = Math.floor((ih - size) / 2);
    sw = size;
    sh = size;
    // アップスケール抑止
    const out = Math.min(max, size);
    dw = out;
    dh = out;
  } else {
    const scale = Math.min(1, max / Math.max(iw, ih)); // ← ここで拡大を抑止
    dw = Math.max(1, Math.round(iw * scale));
    dh = Math.max(1, Math.round(ih * scale));
    sx = 0;
    sy = 0;
    sw = iw;
    sh = ih;
  }

  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas生成失敗');

  // 高品質リサイズ
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (background && type !== 'image/png') {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, dw, dh);
  }

  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);

  // Safari 対策付きで Blob 取得
  const blob = await canvasToBlob(canvas, type, quality);
  if (!blob) throw new Error('Blob変換失敗');
  return blob;
}
