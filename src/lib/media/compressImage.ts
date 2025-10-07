// ブラウザで軽量JPEGに変換
export async function compressImage(file: File, maxSide = 1280, quality = 0.8) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' });
  }
  