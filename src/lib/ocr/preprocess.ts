/* ブラウザ Canvas 前提 */

const DEFAULT_WHITE = 255;

export function imageToCanvas(img: HTMLImageElement|ImageBitmap, maxW = 2000) {
  const W = Math.min(maxW, img.width);
  const H = Math.round(img.height * (W / img.width));
  const cnv = document.createElement('canvas');
  cnv.width = W; cnv.height = H;
  const ctx = cnv.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img as any, 0, 0, W, H);
  return cnv;
}

/** 吹き出し色を白に、文字は黒に寄せる簡易2値化 */
export function binarizeCanvas(cnv: HTMLCanvasElement) {
  const ctx = cnv.getContext('2d')!;
  const { width: W, height: H } = cnv;
  const id = ctx.getImageData(0, 0, W, H);
  const d = id.data;

  // 1) 吹き出し色マスク（LINE系の淡色を白に）
  for (let i=0;i<d.length;i+=4) {
    const r=d[i], g=d[i+1], b=d[i+2];
    const bubble =
      (g>r+10 && g>b+10 && g>150) ||     // 緑
      (b>r+10 && b>150) ||               // 水色
      (r>200 && g>200 && b>200);         // 明灰
    if (bubble) d[i]=d[i+1]=d[i+2]=DEFAULT_WHITE;
  }

  // 2) グレースケール
  const gray = new Uint8ClampedArray((d.length/4)|0);
  for (let i=0,j=0;i<d.length;i+=4,j++) {
    gray[j] = (0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2])|0;
  }

  // 3) ヒストグラムから閾値（簡易Otsu）
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  let max = 0, idx = 180;
  for (let i=0;i<256;i++) if (hist[i]>max){max=hist[i];idx=i;}
  const thr = Math.min(210, Math.max(120, idx+10));

  // 4) 2値化＋軽いノイズ除去
  for (let i=0,j=0;i<d.length;i+=4,j++) {
    const v = gray[j] > thr ? 255 : 0;
    d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
  }
  ctx.putImageData(id, 0, 0);
  return cnv;
}

/** 横の白帯で粗く分割 → マージン含めてトリム */
export function splitHorizontalStrips(cnv: HTMLCanvasElement) {
  const ctx = cnv.getContext('2d')!;
  const { width: W, height: H } = cnv;
  const id = ctx.getImageData(0, 0, W, H);
  const d = id.data;

  const rowBlack = new Array(H).fill(0);
  for (let y=0; y<H; y++) {
    let cnt = 0;
    for (let x=0; x<W; x++) {
      const i = (y*W + x) * 4;
      if (d[i] < 128) cnt++; // 黒
    }
    rowBlack[y] = cnt;
  }
  // 連続して黒が少ない（=白帯）でカット
  const CUT = Math.max(6, Math.floor(H*0.01));
  const TH  = Math.max(10, Math.floor(W*0.02));
  const ranges: Array<[number,number]> = [];
  let s = 0;
  for (let y=0; y<H; y++) {
    if (rowBlack[y] < TH) { // 白
      if (y - s > CUT) ranges.push([s, y]);
      s = y+1;
    }
  }
  if (H - s > CUT) ranges.push([s, H]);

  // トリムしてキャンバス配列化
  return ranges.map(([y1,y2]) => {
    const h = y2 - y1;
    const sub = document.createElement('canvas');
    sub.width = W; sub.height = h;
    sub.getContext('2d')!.drawImage(cnv, 0, y1, W, h, 0, 0, W, h);
    return sub;
  });
}
