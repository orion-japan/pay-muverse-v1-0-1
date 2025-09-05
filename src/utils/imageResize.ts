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
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
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
    }, type, quality);
  });
}

/**
 * 画像を読み込み、リサイズして Blob を返す
 * - `square: true` の場合は中央で正方形にクロップしてから `max` に収める
 * - それ以外はアスペクト比を維持して長辺を `max` に揃える
 */
export async function resizeImage(file: File, opts: ResizeOptions = {}): Promise<Blob> {
  const {
    max = 256,
    square = false,
    type = 'image/png',
    quality = 0.92,
    background = null,
  } = opts;

  // 画像読み込み
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
  let sw = 0, sh = 0, sx = 0, sy = 0; // ソース側の切り出し
  let dw = 0, dh = 0;                 // 出力キャンバスサイズ

  if (square) {
    const size = Math.min(iw, ih);
    sx = Math.floor((iw - size) / 2);
    sy = Math.floor((ih - size) / 2);
    sw = size; sh = size;
    dw = max; dh = max;
  } else {
    const scale = max / Math.max(iw, ih);
    dw = Math.round(iw * scale);
    dh = Math.round(ih * scale);
    sx = 0; sy = 0; sw = iw; sh = ih;
  }

  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas生成失敗');

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
