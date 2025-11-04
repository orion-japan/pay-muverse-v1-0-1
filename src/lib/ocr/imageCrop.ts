async function toImageBitmap(file: File): Promise<ImageBitmap> {
  const buf = await file.arrayBuffer();
  const blob = new Blob([buf]);
  return await createImageBitmap(blob);
}

function drawToCanvasLike(
  img: ImageBitmap,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): HTMLCanvasElement | OffscreenCanvas {
  // OffscreenCanvas があれば使う
  const canUseOffscreen = typeof (globalThis as any).OffscreenCanvas === 'function';
  const canvas = canUseOffscreen
    ? new (globalThis as any).OffscreenCanvas(sw, sh)
    : document.createElement('canvas');
  if (!(canvas as any).convertToBlob) {
    // HTMLCanvasElement の場合はサイズ指定
    (canvas as HTMLCanvasElement).width = sw;
    (canvas as HTMLCanvasElement).height = sh;
  }
  const ctx = (canvas as any).getContext('2d')!;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

async function canvasLikeToBlob(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' });
  }
  return await new Promise<Blob>((resolve) =>
    (canvas as HTMLCanvasElement).toBlob((b) => resolve(b!), 'image/png'),
  );
}

/** LINE系スクショの上下帯を比率でカットしてPNG Blobに */
export async function cropForChatLike(
  file: File,
  ratio = { top: 0.08, bottom: 0.09, left: 0.02, right: 0.02 },
): Promise<Blob> {
  const img = await toImageBitmap(file);
  const W = img.width,
    H = img.height;
  const TOP = Math.round(H * (ratio.top ?? 0));
  const BOTTOM = Math.round(H * (ratio.bottom ?? 0));
  const LEFT = Math.round(W * (ratio.left ?? 0));
  const RIGHT = Math.round(W * (ratio.right ?? 0));
  const cw = Math.max(10, W - LEFT - RIGHT);
  const ch = Math.max(10, H - TOP - BOTTOM);

  const canvas = drawToCanvasLike(img, LEFT, TOP, cw, ch);
  return await canvasLikeToBlob(canvas);
}
