// src/lib/ocr/imagePrep.ts

// 既存：安全な拡大＋上下トリムのみ
export async function upscaleTrimOnly(
  file: File,
  scale = 3,
  topCut = 0.06,
  bottomCut = 0.06,
): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const cutY = Math.floor(h * topCut);
  const cutH = Math.floor(h * (1 - topCut - bottomCut));
  const cvs =
    'OffscreenCanvas' in globalThis
      ? new OffscreenCanvas(w, cutH)
      : (Object.assign(document.createElement('canvas'), {
          width: w,
          height: cutH,
        }) as HTMLCanvasElement);
  const ctx = (cvs as any).getContext('2d', { willReadFrequently: true })!;
  // @ts-ignore
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 0, -cutY, w, h);
  const out = (await (cvs as any).convertToBlob)
    ? (cvs as OffscreenCanvas).convertToBlob({ type: 'image/png', quality: 1 })
    : new Promise<Blob>((r) => (cvs as HTMLCanvasElement).toBlob((b) => r(b!), 'image/png', 1));
  bmp.close();
  return out;
}

// 既存：弱め前処理（拡大→グレー→Otsu）
export async function prepImageSoft(file: File): Promise<Blob> {
  const src = await upscaleTrimOnly(file, 3, 0.06, 0.06);
  const bmp = await createImageBitmap(src);
  const w = bmp.width,
    h = bmp.height;
  const cvs =
    'OffscreenCanvas' in globalThis
      ? new OffscreenCanvas(w, h)
      : (Object.assign(document.createElement('canvas'), {
          width: w,
          height: h,
        }) as HTMLCanvasElement);
  const ctx = (cvs as any).getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  // グレースケール
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = d[i + 1] = d[i + 2] = g;
  }

  // Otsu
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
  let sum = 0,
    total = 0;
  for (let i = 0; i < 256; i++) {
    sum += i * hist[i];
    total += hist[i];
  }
  let sumB = 0,
    wB = 0,
    maxVar = -1,
    thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB,
      mF = (sum - sumB) / wF;
    const vb = wB * wF * (mB - mF) * (mB - mF);
    if (vb > maxVar) {
      maxVar = vb;
      thr = t;
    }
  }
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] > thr ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }

  ctx.putImageData(img, 0, 0);
  const out = (await (cvs as any).convertToBlob)
    ? (cvs as OffscreenCanvas).convertToBlob({ type: 'image/png', quality: 1 })
    : new Promise<Blob>((r) => (cvs as HTMLCanvasElement).toBlob((b) => r(b!), 'image/png', 1));
  bmp.close();
  return out;
}

// 既存：吹き出し抽出（Blob[]）— 従来呼び出しの互換維持
export async function extractBubbleBlobs(file: File): Promise<Blob[]> {
  const metas = await extractBubbleBlobsMeta(file);
  return metas.map((m) => m.blob);
}

// ───────────────────────────────────────────────────────────────
// 追加：メタ付き吹き出し抽出（位置と平均色を返す）
// 既存 API を壊さないため、新しい関数として“追加”します。
export async function extractBubbleBlobsMeta(file: File): Promise<
  Array<{
    blob: Blob;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    avgHue: number;
    avgL: number;
    pageWidth: number;
    pageHeight: number;
  }>
> {
  // まず安全に拡大＋トリム
  const base = await upscaleTrimOnly(file, 3, 0.06, 0.06);
  const bmp = await createImageBitmap(base);
  const W = bmp.width,
    H = bmp.height;

  const cvs =
    'OffscreenCanvas' in globalThis
      ? new OffscreenCanvas(W, H)
      : (Object.assign(document.createElement('canvas'), {
          width: W,
          height: H,
        }) as HTMLCanvasElement);
  const ctx = (cvs as any).getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;

  // 1) 白/緑のマスク
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = d[i] / 255,
        g = d[i + 1] / 255,
        b = d[i + 2] / 255;
      const max = Math.max(r, g, b),
        min = Math.min(r, g, b);
      const l = (max + min) / 2;
      let hDeg = 0;
      if (max !== min) {
        const delta = max - min;
        if (max === g) hDeg = 60 * ((b - r) / delta + 2);
        else if (max === b) hDeg = 60 * ((r - g) / delta + 4);
        else hDeg = 60 * ((g - b) / delta);
        if (hDeg < 0) hDeg += 360;
      }
      const isWhite = l > 0.82;
      const isGreen = hDeg >= 80 && hDeg <= 170 && l > 0.55;
      mask[y * W + x] = isWhite || isGreen ? 1 : 0;
    }
  }

  // 2) 連結成分（4近傍）
  const visited = new Uint8Array(W * H);
  const boxes: { x1: number; y1: number; x2: number; y2: number; area: number }[] = [];
  const qx = new Int32Array(W * H);
  const qy = new Int32Array(W * H);

  const bfs = (sx: number, sy: number) => {
    let head = 0,
      tail = 0;
    qx[tail] = sx;
    qy[tail] = sy;
    tail++;
    visited[sy * W + sx] = 1;
    let x1 = sx,
      y1 = sy,
      x2 = sx,
      y2 = sy,
      area = 0;

    while (head < tail) {
      const x = qx[head],
        y = qy[head];
      head++;
      area++;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
      const nx = [x - 1, x + 1, x, x],
        ny = [y, y, y - 1, y + 1];
      for (let k = 0; k < 4; k++) {
        const xx = nx[k],
          yy = ny[k];
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const idx = yy * W + xx;
        if (!visited[idx] && mask[idx]) {
          visited[idx] = 1;
          qx[tail] = xx;
          qy[tail] = yy;
          tail++;
        }
      }
    }
    return { x1, y1, x2, y2, area };
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (mask[idx] && !visited[idx]) {
        const box = bfs(x, y);
        boxes.push(box);
      }
    }
  }

  // 3) ノイズ除去＆整形（サイズしきい値＆少し内側に縮める）
  const minArea = W * H * 0.01; // 1%以上
  const maxArea = W * H * 0.6; // 60%以下
  const cleaned = boxes
    .filter((b) => b.area >= minArea && b.area <= maxArea)
    .map((b) => {
      const pad = 6;
      const x1 = Math.max(0, b.x1 + pad);
      const y1 = Math.max(0, b.y1 + pad);
      const x2 = Math.min(W - 1, b.x2 - pad);
      const y2 = Math.min(H - 1, b.y2 - pad);
      return { x1, y1, x2, y2, area: (x2 - x1 + 1) * (y2 - y1 + 1) };
    })
    .sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1); // 上→下→左

  // 4) クロップして Blob 化＋平均色（Hue/L）を計算
  const outs: Array<{
    blob: Blob;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    avgHue: number;
    avgL: number;
    pageWidth: number;
    pageHeight: number;
  }> = [];

  for (const b of cleaned) {
    const cw = b.x2 - b.x1 + 1,
      ch = b.y2 - b.y1 + 1;
    const oc =
      'OffscreenCanvas' in globalThis
        ? new OffscreenCanvas(cw, ch)
        : (Object.assign(document.createElement('canvas'), {
            width: cw,
            height: ch,
          }) as HTMLCanvasElement);
    const octx = (oc as any).getContext('2d', { willReadFrequently: true })!;
    octx.drawImage(cvs as any, b.x1, b.y1, cw, ch, 0, 0, cw, ch);

    // 平均色（Hue/L）
    const img2 = octx.getImageData(0, 0, cw, ch).data;
    let rSum = 0,
      gSum = 0,
      bSum = 0,
      n = 0;
    for (let i = 0; i < img2.length; i += 4) {
      rSum += img2[i];
      gSum += img2[i + 1];
      bSum += img2[i + 2];
      n++;
    }
    const r = rSum / (255 * n),
      g = gSum / (255 * n),
      bl = bSum / (255 * n);
    const max = Math.max(r, g, bl),
      min = Math.min(r, g, bl);
    const l = (max + min) / 2;
    let hDeg = 0;
    if (max !== min) {
      const delta = max - min;
      if (max === g) hDeg = 60 * ((bl - r) / delta + 2);
      else if (max === bl) hDeg = 60 * ((r - g) / delta + 4);
      else hDeg = 60 * ((g - bl) / delta);
      if (hDeg < 0) hDeg += 360;
    }

    const blob = await ((oc as any).convertToBlob
      ? (oc as OffscreenCanvas).convertToBlob({ type: 'image/png', quality: 1 })
      : new Promise<Blob>((r2) =>
          (oc as HTMLCanvasElement).toBlob((b2) => r2(b2!), 'image/png', 1),
        ));

    outs.push({
      blob,
      x1: b.x1,
      y1: b.y1,
      x2: b.x2,
      y2: b.y2,
      avgHue: hDeg,
      avgL: l,
      pageWidth: W,
      pageHeight: H,
    });
  }

  bmp.close();
  return outs;
}
