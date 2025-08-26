"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/*
  IboardCollageMaker.tsx
  ---------------------------------------------------------
  - iBoardで選んだ複数画像（File or URL）から、即席でコラージュ画像を生成します。
  - Tailwind不使用。最低限のスタイルは inline & <style> で内包。
  - 1〜6枚までの自動レイアウト（正方形/4:5/3:4/16:9 比率に対応）。
  - 余白（gap）/ 角丸 / 背景色（白 or 透明）を調整可能。
  - PNG/JPEGダウンロード、または onExport コールバックで親へ返却。

  ■ 想定統合：
    <IboardCollageMaker
      initialImages={["https://.../image1.jpg", file2, file3]}
      onExport={(blob, dataUrl) => {
        // Supabaseにアップロード、または posts.media_urls に保存…など
      }}
    />

  ■ CORS注意：
    画像URLが他ドメインの場合は、Storage 側で CORS 許可が必要です。
    下記で Image.crossOrigin = "anonymous" を指定していますが、
    サーバー応答に Access-Control-Allow-Origin が無いと Canvas に描画できません。
*/

// === 型 ===
type CollageRatio = "1:1" | "4:5" | "3:4" | "16:9";
type ExportFormat = "png" | "jpeg";

// ユーザーが選んだ画像を統一的に扱うための型
interface Picked {
  id: string;        // 一意キー
  src: string;       // 表示＆描画用URL（File の場合は ObjectURL）
  file?: File | null;
  name?: string;
}

// === ユーティリティ：cover描画 ===
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number
) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return;
  const r = Math.max(dw / iw, dh / ih); // cover用スケール
  const sw = dw / r;
  const sh = dh / r;
  const sx = (iw - sw) / 2;
  const sy = (ih - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

// === レイアウト矩形を計算（1〜6枚に対応） ===
function computeFrames(
  count: number,
  width: number,
  height: number,
  gap: number,
  radius: number
): Array<{ x: number; y: number; w: number; h: number; r: number }> {
  const frames: Array<{ x: number; y: number; w: number; h: number; r: number }> = [];

  const add = (x: number, y: number, w: number, h: number) => {
    frames.push({ x, y, w, h, r: radius });
  };

  const W = width;
  const H = height;
  const g = gap;

  switch (count) {
    case 1: {
      add(g, g, W - g * 2, H - g * 2);
      break;
    }
    case 2: {
      // 2列分割（縦）
      const colW = (W - g * 3) / 2;
      add(g, g, colW, H - g * 2);
      add(g * 2 + colW, g, colW, H - g * 2);
      break;
    }
    case 3: {
      // 上1枚 / 下2枚（横並び）
      const topH = (H - g * 3) * 0.55;
      add(g, g, W - g * 2, topH);
      const bottomH = H - g * 3 - topH;
      const colW = (W - g * 3) / 2;
      add(g, g * 2 + topH, colW, bottomH);
      add(g * 2 + colW, g * 2 + topH, colW, bottomH);
      break;
    }
    case 4: {
      // 2x2 グリッド
      const colW = (W - g * 3) / 2;
      const rowH = (H - g * 3) / 2;
      add(g, g, colW, rowH);
      add(g * 2 + colW, g, colW, rowH);
      add(g, g * 2 + rowH, colW, rowH);
      add(g * 2 + colW, g * 2 + rowH, colW, rowH);
      break;
    }
    case 5: {
      // 上2 / 下3
      const topH = (H - g * 3) * 0.52;
      const colW2 = (W - g * 3) / 2;
      add(g, g, colW2, topH);
      add(g * 2 + colW2, g, colW2, topH);
      const bottomH = H - g * 3 - topH;
      const colW3 = (W - g * 4) / 3;
      add(g, g * 2 + topH, colW3, bottomH);
      add(g * 2 + colW3, g * 2 + topH, colW3, bottomH);
      add(g * 3 + colW3 * 2, g * 2 + topH, colW3, bottomH);
      break;
    }
    default: {
      // 6枚〜：3x2 グリッド（6枚に最適化。7枚以上は先頭6枚）
      const n = Math.min(count, 6);
      const colW = (W - g * 4) / 3;
      const rowH = (H - g * 3) / 2;
      let idx = 0;
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          if (idx >= n) break;
          const x = g + col * (colW + g);
          const y = g + row * (rowH + g);
          add(x, y, colW, rowH);
          idx++;
        }
      }
      break;
    }
  }
  return frames;
}

// === メインコンポーネント ===
export default function IboardCollageMaker({
  initialImages = [],
  onExport,
}: {
  initialImages?: (string | File)[];
  onExport?: (blob: Blob, dataUrl: string) => void;
}) {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [ratio, setRatio] = useState<CollageRatio>("1:1");
  const [exportSize, setExportSize] = useState<number>(2048); // 長辺ピクセル
  const [gap, setGap] = useState<number>(16);
  const [radius, setRadius] = useState<number>(24);
  const [bgTransparent, setBgTransparent] = useState<boolean>(false);
  const [format, setFormat] = useState<ExportFormat>("png");
  const [quality, setQuality] = useState<number>(0.92); // JPEGのみ

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLImageElement | null>(null);
  const [rendering, setRendering] = useState<boolean>(false);

  // 初期画像の反映
  useEffect(() => {
    if (!initialImages?.length) return;
    const arr: Picked[] = initialImages.map((it, i) => {
      if (typeof it === "string") {
        return { id: `u-${i}-${Date.now()}`, src: it, name: it.split("/").pop() };
      }
      const src = URL.createObjectURL(it);
      return { id: `f-${i}-${Date.now()}`, src, file: it, name: it.name };
    });
    setPicked(arr);
    // File の ObjectURL はアンマウント時に revoke
    return () => {
      arr.forEach(p => p.file && URL.revokeObjectURL(p.src));
    };
  }, [initialImages]);

  // ファイル追加
  const onFiles = useCallback((files: FileList | null) => {
    if (!files?.length) return;
    const add: Picked[] = Array.from(files).map((f, i) => ({
      id: `f-${Date.now()}-${i}`,
      src: URL.createObjectURL(f),
      file: f,
      name: f.name,
    }));
    setPicked(prev => [...prev, ...add].slice(0, 6));
  }, []);

  // 並べ替え（上/下）
  const move = (idx: number, dir: -1 | 1) => {
    setPicked(prev => {
      const next = [...prev];
      const ni = idx + dir;
      if (ni < 0 || ni >= next.length) return prev;
      [next[idx], next[ni]] = [next[ni], next[idx]];
      return next;
    });
  };

  const remove = (idx: number) => {
    setPicked(prev => prev.filter((_, i) => i !== idx));
  };

  const clearAll = () => setPicked([]);

  // 出力サイズの計算（比率に応じて短辺を算出）
  const size = useMemo(() => {
    const [wRatio, hRatio] = ratio.split(":" as any).map(Number);
    const W = exportSize;
    const H = Math.round((exportSize * hRatio) / wRatio);
    return { W, H };
  }, [exportSize, ratio]);

  // コラージュ描画
  const render = useCallback(async () => {
    if (!picked.length) return;
    setRendering(true);

    const { W, H } = size;
    const canvas = canvasRef.current || document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = W;
    canvas.height = H;

    // 背景
    if (bgTransparent) {
      ctx.clearRect(0, 0, W, H);
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
    }

    const frames = computeFrames(picked.length, W, H, gap, radius);

    // 画像を順に描画
    for (let i = 0; i < frames.length; i++) {
      const fr = frames[i];
      const p = picked[i];
      if (!p) break;

      // 画像の読み込み
      const img = await loadImage(p.src);

      // 角丸クリップ
      if (fr.r > 0) {
        roundRectPath(ctx, fr.x, fr.y, fr.w, fr.h, fr.r);
        ctx.save();
        ctx.clip();
        drawImageCover(ctx, img, fr.x, fr.y, fr.w, fr.h);
        ctx.restore();
      } else {
        drawImageCover(ctx, img, fr.x, fr.y, fr.w, fr.h);
      }
    }

    // プレビュー
    const dataUrl = canvas.toDataURL(`image/${format}`);
    if (previewRef.current) previewRef.current.src = dataUrl;

    setRendering(false);
    return canvas;
  }, [picked, size, gap, radius, bgTransparent, format]);

  // ダウンロード／エクスポート
  const download = useCallback(async () => {
    const canvas = await render();
    if (!canvas) return;
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const dataUrl = canvas.toDataURL(`image/${format}`);
        if (onExport) onExport(blob, dataUrl);
        // 即ダウンロード
        const a = document.createElement("a");
        const ext = format === "png" ? "png" : "jpg";
        a.download = `collage_${Date.now()}.${ext}`;
        a.href = URL.createObjectURL(blob);
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      },
      format === "png" ? "image/png" : "image/jpeg",
      format === "png" ? undefined : quality
    );
  }, [render, format, quality, onExport]);

  // 自動レンダリング（設定が変わったら毎回プレビュー更新）
  useEffect(() => {
    if (!picked.length) return;
    render();
  }, [picked, ratio, exportSize, gap, radius, bgTransparent, format, quality, render]);

  return (
    <div style={styles.wrap}>
      <div style={styles.leftPanel}>
        <h3 style={{ margin: 0 }}>📸 コラージュメーカー</h3>
        <p style={{ marginTop: 6, color: "#666" }}>最大6枚まで。順番は ↑↓ で変更できます。</p>

        {/* 画像選択 */}
        <div style={styles.card}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <label style={styles.fileButton}>
              画像を追加
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => onFiles(e.target.files)}
                style={{ display: "none" }}
              />
            </label>
            <button style={styles.secondaryBtn} onClick={clearAll} disabled={!picked.length}>全部クリア</button>
          </div>

          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {picked.map((p, i) => (
              <div key={p.id} style={styles.thumbCell}>
                <img src={p.src} alt={p.name || `image-${i}`} style={styles.thumbImg} />
                <div style={styles.thumbOps}>
                  <button title="上へ" onClick={() => move(i, -1)} disabled={i === 0} style={styles.iconBtn}>↑</button>
                  <button title="下へ" onClick={() => move(i, 1)} disabled={i === picked.length - 1} style={styles.iconBtn}>↓</button>
                  <button title="削除" onClick={() => remove(i)} style={styles.iconBtn}>✕</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 設定 */}
        <div style={styles.card}>
          <div style={styles.row}>
            <label style={styles.label}>比率</label>
            <select value={ratio} onChange={(e) => setRatio(e.target.value as CollageRatio)} style={styles.select}>
              <option value="1:1">1:1（正方形）</option>
              <option value="4:5">4:5（Instagram推奨縦）</option>
              <option value="3:4">3:4</option>
              <option value="16:9">16:9（横長）</option>
            </select>
          </div>

          <div style={styles.row}>
            <label style={styles.label}>長辺ピクセル</label>
            <input type="number" min={512} max={4096} step={64} value={exportSize} onChange={(e) => setExportSize(parseInt(e.target.value || "2048", 10))} style={styles.number} />
          </div>

          <div style={styles.row}>
            <label style={styles.label}>余白（gap）</label>
            <input type="range" min={0} max={64} step={1} value={gap} onChange={(e) => setGap(parseInt(e.target.value, 10))} style={{ flex: 1 }} />
            <span style={styles.value}>{gap}px</span>
          </div>

          <div style={styles.row}>
            <label style={styles.label}>角丸</label>
            <input type="range" min={0} max={64} step={1} value={radius} onChange={(e) => setRadius(parseInt(e.target.value, 10))} style={{ flex: 1 }} />
            <span style={styles.value}>{radius}px</span>
          </div>

          <div style={styles.row}>
            <label style={styles.label}>背景</label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={bgTransparent} onChange={(e) => setBgTransparent(e.target.checked)} /> 透明PNG
            </label>
          </div>

          <div style={styles.row}>
            <label style={styles.label}>書き出し</label>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} style={styles.selectSmall}>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
              </select>
              {format === "jpeg" && (
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  品質
                  <input type="range" min={0.5} max={1} step={0.01} value={quality} onChange={(e) => setQuality(parseFloat(e.target.value))} />
                  <span style={styles.value}>{Math.round(quality * 100)}%</span>
                </label>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
            <button style={styles.primaryBtn} onClick={download} disabled={!picked.length || rendering}>
              {rendering ? "レンダリング中…" : "コラージュをダウンロード"}
            </button>
            <button style={styles.secondaryBtn} onClick={render} disabled={!picked.length || rendering}>プレビュー更新</button>
          </div>
        </div>
      </div>

      {/* プレビュー */}
      <div style={styles.rightPanel}>
        <div style={styles.previewBox}>
          <img ref={previewRef} alt="preview" style={{ width: "100%", height: "auto", display: "block", borderRadius: 16, boxShadow: "0 6px 24px rgba(0,0,0,0.08)" }} />
          {!picked.length && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#888" }}>
              画像を追加するとプレビューが表示されます
            </div>
          )}
        </div>
        <canvas ref={canvasRef} style={{ display: "none" }} />
      </div>

      {/* 追加の内包スタイル */}
      <style>{`
        /* スクロール時の視覚的な質感向上 */
        .iboard-cm__panel::-webkit-scrollbar { width: 10px; height: 10px; }
        .iboard-cm__panel::-webkit-scrollbar-thumb { background: #d0d0d0; border-radius: 8px; }
        .iboard-cm__panel::-webkit-scrollbar-track { background: transparent; }
      `}</style>
    </div>
  );
}

// === 画像ローダ ===
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // CORS対応
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

// === 角丸パス ===
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// === スタイル（CSSは別ファイル分離も可。ここでは内包） ===
const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: "grid",
    gridTemplateColumns: "380px 1fr",
    gap: 16,
    alignItems: "start",
  },
  leftPanel: {
    position: "sticky",
    top: 0,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    maxHeight: "calc(100vh - 24px)",
    overflow: "auto",
  },
  rightPanel: {
    minHeight: 360,
  },
  card: {
    border: "1px solid #e7e7e7",
    borderRadius: 12,
    padding: 12,
    background: "#fff",
    boxShadow: "0 2px 12px rgba(0,0,0,0.04)",
  },
  row: { display: "flex", alignItems: "center", gap: 12, marginTop: 10 },
  label: { width: 90, color: "#333" },
  value: { minWidth: 40, textAlign: "right", color: "#666" },
  select: { flex: 1, padding: "6px 10px", borderRadius: 8, border: "1px solid #ddd" },
  selectSmall: { padding: "6px 10px", borderRadius: 8, border: "1px solid #ddd" },
  number: { width: 120, padding: "6px 10px", borderRadius: 8, border: "1px solid #ddd" },
  fileButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid #ccc",
    background: "#fafafa",
    cursor: "pointer",
  },
  primaryBtn: {
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid #6b5bfa",
    background: "linear-gradient(180deg, #8f7dff 0%, #6b5bfa 100%)",
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0 6px 18px rgba(122, 101, 255, 0.25)",
  },
  secondaryBtn: {
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid #ddd",
    background: "#fff",
    color: "#333",
    cursor: "pointer",
  },
  thumbCell: {
    position: "relative",
    borderRadius: 8,
    overflow: "hidden",
    border: "1px solid #eee",
    background: "#f7f7f7",
    aspectRatio: "1 / 1",
  },
  thumbImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  thumbOps: {
    position: "absolute",
    inset: 6,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "start",
  },
  iconBtn: {
    border: "1px solid #ddd",
    background: "rgba(255,255,255,0.9)",
    padding: "2px 6px",
    borderRadius: 6,
    cursor: "pointer",
  },
  previewBox: {
    position: "relative",
    width: "100%",
    maxWidth: 900,
    margin: "0 auto",
    background: "#fff",
    padding: 12,
    borderRadius: 16,
    border: "1px solid #eee",
  },
};
