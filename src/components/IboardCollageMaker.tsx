'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';

/* ================== 設定 ================== */
type CollageRatio = '1:1' | '4:5' | '3:4' | '16:9';
type ExportFormat = 'png' | 'jpeg';
type ExportTarget = 'download' | 'album';

interface Picked {
  id: string;
  src: string;
  file?: File | null;
  name?: string;
}

type AlbumItem = {
  name: string;
  url: string;
  path: string;
  size?: number | null;
  updated_at?: string | null;
};

async function listAlbumImages(userCode: string): Promise<AlbumItem[]> {
  try {
    const prefix = (userCode || '').trim();
    if (!prefix) return [];
    const { data, error } = await supabase.storage
      .from('private-posts')
      .list(prefix, { limit: 1000 });
    if (error) throw error;

    const files = (data || []).filter(
      (f) => !!f.name && !f.name.startsWith('.') && !f.name.endsWith('/'),
    );
    files.sort((a: any, b: any) => (b.name || '').localeCompare(a.name || '')); // 名前末尾にタイムスタンプ前提で降順

    const rows: AlbumItem[] = [];
    for (const f of files) {
      const path = `${prefix}/${f.name}`;
      const { data: signed } = await supabase.storage
        .from('private-posts')
        .createSignedUrl(path, 60 * 30);
      rows.push({
        name: f.name,
        url: signed?.signedUrl ?? '',
        path,
        size: (f as any)?.metadata?.size ?? null,
        updated_at: (f as any)?.updated_at ?? null,
      });
    }
    return rows;
  } catch (e) {
    console.warn('listAlbumImages error:', e);
    return [];
  }
}

/* ====== Album ピッカー ====== */
function AlbumModal({
  open,
  userCode,
  onClose,
  onPick,
  reloadKey = 0,
}: {
  open: boolean;
  userCode?: string | null;
  onClose: () => void;
  onPick: (urls: string[]) => void;
  reloadKey?: number;
}) {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<AlbumItem[]>([]);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [thumbSize, setThumbSize] = useState<number>(80);

  useEffect(() => {
    if (!open) return;
    const u = (userCode || '').trim();
    if (!u) return;
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const rows = await listAlbumImages(u);
        if (alive) {
          setItems(rows);
          setSel({});
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, userCode, reloadKey]);

  const toggle = (p: string) => setSel((prev) => ({ ...prev, [p]: !prev[p] }));
  const selected = items.filter((it) => sel[it.path]).map((it) => it.url);

  if (!open) return null;

  return (
    <div style={amStyles.backdrop} onClick={onClose}>
      <div style={amStyles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={amStyles.head}>
          <div style={{ fontWeight: 600 }}>アルバムから選ぶ</div>
          <button style={amStyles.iconBtn} onClick={onClose}>
            ✕
          </button>
        </div>

        {!userCode?.trim() ? (
          <div style={amStyles.hint}>ユーザーコードを取得中です…</div>
        ) : loading ? (
          <div style={amStyles.hint}>読み込み中…</div>
        ) : items.length === 0 ? (
          <div style={amStyles.hint}>アルバムに画像がありません。</div>
        ) : (
          <>
            <div style={amStyles.sliderRow}>
              <span style={{ color: '#666', fontSize: 12 }}>サムネ</span>
              <input
                type="range"
                min={50}
                max={180}
                step={5}
                value={thumbSize}
                onChange={(e) => setThumbSize(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <span style={{ color: '#666', fontSize: 12, width: 44, textAlign: 'right' }}>
                {thumbSize}px
              </span>
            </div>
            <div style={{ ...amStyles.grid, ['--thumb' as any]: `${thumbSize}px` }}>
              {items.map((it) => (
                <label key={it.path} style={amStyles.cell} title={it.name}>
                  <input
                    type="checkbox"
                    checked={!!sel[it.path]}
                    onChange={() => toggle(it.path)}
                    style={amStyles.check}
                  />
                  <img src={it.url} alt={it.name} style={amStyles.thumb} crossOrigin="anonymous" />
                  <div style={amStyles.name}>{it.name}</div>
                </label>
              ))}
            </div>
          </>
        )}

        <div style={amStyles.footer}>
          <button style={amStyles.secondaryBtn} onClick={onClose}>
            キャンセル
          </button>
          <button
            style={amStyles.primaryBtn}
            onClick={() => onPick(selected)}
            disabled={selected.length === 0}
          >
            追加（{selected.length}）
          </button>
        </div>
      </div>
    </div>
  );
}

/* ====== 本体 ====== */
export default function IboardCollageMaker({
  initialImages = [],
  onExport,
}: {
  initialImages?: (string | File)[];
  onExport?: (blob: Blob, dataUrl: string) => void;
}) {
  const { userCode } = useAuth(); // 数値 userCode を想定
  const [albumOpen, setAlbumOpen] = useState(false);
  const [albumReloadKey, setAlbumReloadKey] = useState(0);

  const [picked, setPicked] = useState<Picked[]>([]);
  const [ratio, setRatio] = useState<CollageRatio>('1:1');
  const [exportSize, setExportSize] = useState<number>(2048);
  const [gap, setGap] = useState<number>(16);
  const [radius, setRadius] = useState<number>(24);
  const [bgTransparent, setBgTransparent] = useState<boolean>(false);
  const [format, setFormat] = useState<ExportFormat>('png');
  const [quality, setQuality] = useState<number>(0.92);
  const [target, setTarget] = useState<ExportTarget>('album');
  const [fileName, setFileName] = useState<string>(() => makeDefaultName());
  const [msg, setMsg] = useState<string | null>(null);
  const [rendering, setRendering] = useState<boolean>(false);
  const [exporting, setExporting] = useState<boolean>(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLImageElement | null>(null);

  // 初期反映
  useEffect(() => {
    if (!initialImages?.length) return;
    const arr: Picked[] = initialImages.map((it, i) => {
      if (typeof it === 'string')
        return { id: `u-${i}-${Date.now()}`, src: it, name: it.split('/').pop() || `url-${i}` };
      const src = URL.createObjectURL(it);
      return { id: `f-${i}-${Date.now()}`, src, file: it, name: it.name };
    });
    setPicked(arr);
    return () => {
      arr.forEach((p) => p.file && URL.revokeObjectURL(p.src));
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
    setPicked((prev) => [...prev, ...add].slice(0, 6));
  }, []);

  // 並べ替え/削除
  const move = (idx: number, dir: -1 | 1) => {
    setPicked((prev) => {
      const next = [...prev];
      const ni = idx + dir;
      if (ni < 0 || ni >= next.length) return prev;
      [next[idx], next[ni]] = [next[ni], next[idx]];
      return next;
    });
  };
  const remove = (idx: number) => setPicked((prev) => prev.filter((_, i) => i !== idx));
  const clearAll = () => setPicked([]);

  // 出力サイズ
  const size = useMemo(() => {
    const [wRatio, hRatio] = (ratio as string).split(':').map(Number);
    const W = exportSize;
    const H = Math.round((exportSize * hRatio) / wRatio);
    return { W, H };
  }, [exportSize, ratio]);

  // レンダリング
  const render = useCallback(async () => {
    if (!picked.length) return null;
    setRendering(true);
    const { W, H } = size;
    const canvas = canvasRef.current || document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setRendering(false);
      return null;
    }

    canvas.width = W;
    canvas.height = H;

    if (bgTransparent) ctx.clearRect(0, 0, W, H);
    else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
    }

    const frames = computeFrames(picked.length, W, H, gap, radius);
    for (let i = 0; i < frames.length; i++) {
      const fr = frames[i];
      const p = picked[i];
      if (!p) break;
      const img = await loadImage(p.src);
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

    const dataUrl = canvas.toDataURL(`image/${format}`);
    if (previewRef.current) previewRef.current.src = dataUrl;

    setRendering(false);
    return canvas;
  }, [picked, size, gap, radius, bgTransparent, format]);

  // 書き出し（DL or Album）— DB挿入はベストエフォート
  const exportCollage = useCallback(async () => {
    if (!picked.length || exporting) return;
    setExporting(true);
    setMsg(null);
    try {
      const canvas = await render();
      if (!canvas) return;

      const mime = format === 'png' ? 'image/png' : 'image/jpeg';
      const ext = format === 'png' ? 'png' : 'jpg';

      await new Promise<void>((resolve, reject) => {
        canvas.toBlob(
          async (blob) => {
            try {
              if (!blob) return reject(new Error('blob作成に失敗しました'));
              const safeBase = (fileName || 'collage')
                .replace(/[^\w.\-]+/g, '_')
                .replace(/\.+$/, '');
              const finalName = safeBase.endsWith(`.${ext}`) ? safeBase : `${safeBase}.${ext}`;
              const dataUrl = canvas.toDataURL(mime);
              onExport?.(blob, dataUrl);

              if (target === 'download') {
                const a = document.createElement('a');
                a.download = finalName;
                a.href = URL.createObjectURL(blob);
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 2000);
                setMsg('端末にダウンロードしました。');
              } else {
                const ucode = userCode != null ? String(userCode).trim() : '';
                if (!ucode) throw new Error('ユーザーコード未取得のためAlbumへ保存できません。');

                const path = `${ucode}/${Date.now()}_${finalName}`;

                // 1) Storage へ保存（必須）
                const { error: upErr } = await supabase.storage
                  .from('private-posts')
                  .upload(path, blob, {
                    cacheControl: '3600',
                    upsert: true,
                    contentType: mime,
                  });
                if (upErr) {
                  console.error('storage upload error:', upErr);
                  throw upErr;
                }

                // 2) DB への“フラグ行”作成は任意（失敗しても続行）
                try {
                  const res = await fetch('/api/album/insert', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      user_code: ucode,
                      title: finalName,
                      bucket: 'private-posts',
                      path,
                      mime,
                      // tags: ["album", "self"], // タグ検索環境なら有効化
                    }),
                  });
                  if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    console.warn('album insert api warn:', res.status, text);
                  } else {
                    const json = await res.json().catch(() => ({}));
                    if (!json?.ok) console.warn('album insert api non-ok:', json);
                  }
                } catch (e) {
                  console.warn('album insert api error (ignored):', e);
                }

                setMsg(`Album に保存しました：${path}`);
                setAlbumReloadKey((k) => k + 1);
              }

              resolve();
            } catch (e) {
              reject(e);
            }
          },
          mime,
          format === 'png' ? undefined : quality,
        );
      });
    } catch (e: any) {
      const msg =
        e?.message ||
        e?.error?.message ||
        (typeof e === 'object' ? JSON.stringify(e, Object.getOwnPropertyNames(e)) : String(e));
      console.error('export error:', e);
      setMsg(`エラー：${msg}`);
    } finally {
      setExporting(false);
      setFileName(makeDefaultName());
    }
  }, [picked, exporting, render, format, quality, target, fileName, onExport, userCode]);

  useEffect(() => {
    if (picked.length) void render();
  }, [picked, ratio, exportSize, gap, radius, bgTransparent, format, quality, render]);

  return (
    <div style={styles.wrap}>
      <div style={styles.leftPanel}>
        <h3 style={{ margin: 0 }}>📸 コラージュメーカー</h3>
        <p style={{ marginTop: 6, color: '#666' }}>最大6枚まで。順番は ↑↓ で変更できます。</p>

        {/* 画像選択 */}
        <div style={styles.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <label style={styles.fileButton}>
              画像を追加
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => onFiles(e.target.files)}
                style={{ display: 'none' }}
              />
            </label>
            <button style={styles.secondaryBtn} onClick={() => setAlbumOpen(true)}>
              アルバムから選ぶ
            </button>
            <button style={styles.secondaryBtn} onClick={clearAll} disabled={!picked.length}>
              全部クリア
            </button>
          </div>

          <div
            style={{
              marginTop: 12,
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 8,
            }}
          >
            {picked.map((p, i) => (
              <div key={p.id} style={styles.thumbCell}>
                <img src={p.src} alt={p.name || `image-${i}`} style={styles.thumbImg} />
                <div style={styles.thumbOps}>
                  <button
                    title="上へ"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    style={styles.iconBtn}
                  >
                    ↑
                  </button>
                  <button
                    title="下へ"
                    onClick={() => move(i, 1)}
                    disabled={i === picked.length - 1}
                    style={styles.iconBtn}
                  >
                    ↓
                  </button>
                  <button title="削除" onClick={() => remove(i)} style={styles.iconBtn}>
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 設定 */}
        <div style={styles.card}>
          <div style={styles.row}>
            <label style={styles.label}>比率</label>
            <select
              value={ratio}
              onChange={(e) => setRatio(e.target.value as CollageRatio)}
              style={styles.select}
            >
              <option value="1:1">1:1（正方形）</option>
              <option value="4:5">4:5（Instagram推奨縦）</option>
              <option value="3:4">3:4</option>
              <option value="16:9">16:9（横長）</option>
            </select>
          </div>

          <div style={styles.row}>
            <label style={styles.label}>長辺ピクセル</label>
            <input
              type="number"
              min={512}
              max={4096}
              step={64}
              value={exportSize}
              onChange={(e) => setExportSize(parseInt(e.target.value || '2048', 10))}
              style={styles.number}
            />
          </div>

          <div style={styles.row}>
            <label style={styles.label}>余白（gap）</label>
            <input
              type="range"
              min={0}
              max={64}
              step={1}
              value={gap}
              onChange={(e) => setGap(parseInt(e.target.value, 10))}
              style={{ flex: 1 }}
            />
            <span style={styles.value}>{gap}px</span>
          </div>

          <div style={styles.row}>
            <label style={styles.label}>角丸</label>
            <input
              type="range"
              min={0}
              max={64}
              step={1}
              value={radius}
              onChange={(e) => setRadius(parseInt(e.target.value, 10))}
              style={{ flex: 1 }}
            />
            <span style={styles.value}>{radius}px</span>
          </div>

          <div style={styles.row}>
            <label style={styles.label}>背景</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={bgTransparent}
                onChange={(e) => setBgTransparent(e.target.checked)}
              />{' '}
              透明PNG
            </label>
          </div>

          <div style={styles.row}>
            <label style={styles.label}>書き出し形式</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as ExportFormat)}
                style={styles.selectSmall}
              >
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
              </select>
              {format === 'jpeg' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  品質
                  <input
                    type="range"
                    min={0.5}
                    max={1}
                    step={0.01}
                    value={quality}
                    onChange={(e) => setQuality(parseFloat(e.target.value))}
                  />
                  <span style={styles.value}>{Math.round(quality * 100)}%</span>
                </label>
              )}
            </div>
          </div>

          {/* 保存先＆ファイル名 */}
          {/* 保存先＆ファイル名 */}
          {/* 保存先＆ファイル名 */}
          <div style={styles.row}>
            <label style={styles.label}>保存先</label>

            {/* ← 並びを“アルバム → ダウンロード”に */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="radio"
                  name="target"
                  value="album"
                  checked={target === 'album'}
                  onChange={() => setTarget('album')}
                />
                アルバムに保存
              </label>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="radio"
                  name="target"
                  value="download"
                  checked={target === 'download'}
                  onChange={() => setTarget('download')}
                />
                端末にダウンロード
              </label>
            </div>

            {target === 'album' && (
              <div style={{ marginTop: 2, fontSize: 12, color: '#666' }}>
                ※ 反映まで数秒かかることがあります。
              </div>
            )}
          </div>

          <div style={styles.row}>
            <label style={styles.label}>ファイル名</label>
            <input
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="collage_yyyyMMdd_HHmmss"
              style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: '1px solid #ddd' }}
            />
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
            <button
              style={styles.primaryBtn}
              onClick={exportCollage}
              disabled={!picked.length || rendering || exporting}
            >
              {exporting
                ? '書き出し中…'
                : target === 'album'
                  ? 'Albumへ保存'
                  : 'コラージュをダウンロード'}
            </button>
            <button
              style={styles.secondaryBtn}
              onClick={render}
              disabled={!picked.length || rendering}
            >
              プレビュー更新
            </button>
          </div>
          {msg && (
            <div style={{ marginTop: 8, color: msg.startsWith('エラー') ? '#b00020' : '#246b2a' }}>
              {msg}
            </div>
          )}
        </div>
      </div>

      {/* プレビュー */}
      <div style={styles.rightPanel}>
        <div style={styles.previewBox}>
          <img
            ref={previewRef}
            alt="preview"
            style={{
              width: '100%',
              height: 'auto',
              display: 'block',
              borderRadius: 16,
              boxShadow: '0 6px 24px rgba(0,0,0,0.08)',
            }}
          />
          {!picked.length && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#888',
              }}
            >
              画像を追加するとプレビューが表示されます
            </div>
          )}
        </div>
        <canvas ref={canvasRef} style={{ display: 'none' }} />
      </div>

      {/* Album ピッカー */}
      <AlbumModal
        open={albumOpen}
        userCode={userCode != null ? String(userCode) : ''}
        reloadKey={albumReloadKey}
        onClose={() => setAlbumOpen(false)}
        onPick={(urls) => {
          const add = urls.map((u, i) => ({
            id: `a-${Date.now()}-${i}`,
            src: u,
            file: null,
            name: u.split('/').pop() || `album-${i}`,
          }));
          setPicked((prev) => [...prev, ...add].slice(0, 6));
          setAlbumOpen(false);
        }}
      />

      <style>{`
  .iboard-cm__panel::-webkit-scrollbar { width: 10px; height: 10px; }
  .iboard-cm__panel::-webkit-scrollbar-thumb { background: #d0d0d0; border-radius: 8px; }
  .iboard-cm__panel::-webkit-scrollbar-track { background: transparent; }

  /* 📱 モバイル幅では1カラムに切り替え */
  @media (max-width: 860px) {
    .cm-wrap { display: block !important; }
    .cm-left { position: static !important; max-height: none !important; }
    .cm-right { margin-top: 16px !important; }
    body { overflow-x: hidden; } /* 横スクロール防止 */
  }
`}</style>
    </div>
  );
}

/* ========= ユーティリティ ========= */
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  const iw = img.naturalWidth,
    ih = img.naturalHeight;
  if (!iw || !ih) return;
  const r = Math.max(dw / iw, dh / ih);
  const sw = dw / r,
    sh = dh / r;
  const sx = (iw - sw) / 2,
    sy = (ih - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

function computeFrames(count: number, width: number, height: number, gap: number, radius: number) {
  const frames: Array<{ x: number; y: number; w: number; h: number; r: number }> = [];
  const add = (x: number, y: number, w: number, h: number) =>
    frames.push({ x, y, w, h, r: radius });
  const W = width,
    H = height,
    g = gap;
  switch (count) {
    case 1:
      add(g, g, W - g * 2, H - g * 2);
      break;
    case 2: {
      const colW = (W - g * 3) / 2;
      add(g, g, colW, H - g * 2);
      add(g * 2 + colW, g, colW, H - g * 2);
      break;
    }
    case 3: {
      const topH = (H - g * 3) * 0.55;
      add(g, g, W - g * 2, topH);
      const bottomH = H - g * 3 - topH;
      const colW = (W - g * 3) / 2;
      add(g, g * 2 + topH, colW, bottomH);
      add(g * 2 + colW, g * 2 + topH, colW, bottomH);
      break;
    }
    case 4: {
      const colW = (W - g * 3) / 2,
        rowH = (H - g * 3) / 2;
      add(g, g, colW, rowH);
      add(g * 2 + colW, g, colW, rowH);
      add(g, g * 2 + rowH, colW, rowH);
      add(g * 2 + colW, g * 2 + rowH, colW, rowH);
      break;
    }
    case 5: {
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
      const n = Math.min(count, 6);
      const colW = (W - g * 4) / 3,
        rowH = (H - g * 3) / 2;
      let idx = 0;
      for (let row = 0; row < 2; row++)
        for (let col = 0; col < 3; col++) {
          if (idx >= n) break;
          add(g + col * (colW + g), g + row * (rowH + g), colW, rowH);
          idx++;
        }
    }
  }
  return frames;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
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

function makeDefaultName() {
  const d = new Date();
  const p = (n: number, w = 2) => `${n}`.padStart(w, '0');
  return `collage_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ====== スタイル ====== */
const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'grid', gridTemplateColumns: '380px 1fr', gap: 16, alignItems: 'start' },
  leftPanel: {
    position: 'sticky',
    top: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    maxHeight: 'calc(100vh - 24px)',
    overflow: 'auto',
  },
  rightPanel: { minHeight: 360 },
  card: {
    border: '1px solid #e7e7e7',
    borderRadius: 12,
    padding: 12,
    background: '#fff',
    boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
  },
  row: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 },
  label: { width: 90, color: '#333' },
  value: { minWidth: 40, textAlign: 'right', color: '#666' },
  select: { flex: 1, padding: '6px 10px', borderRadius: 8, border: '1px solid #ddd' },
  selectSmall: { padding: '6px 10px', borderRadius: 8, border: '1px solid #ddd' },
  number: { width: 120, padding: '6px 10px', borderRadius: 8, border: '1px solid #ddd' },
  fileButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '10px 14px',
    borderRadius: 8,
    border: '1px solid #ccc',
    background: '#fafafa',
    cursor: 'pointer',
  },
  primaryBtn: {
    padding: '10px 14px',
    borderRadius: 8,
    border: '1px solid #6b5bfa',
    background: 'linear-gradient(180deg, #8f7dff 0%, #6b5bfa 100%)',
    color: '#fff',
    cursor: 'pointer',
    boxShadow: '0 6px 18px rgba(122, 101, 255, 0.25)',
  },
  secondaryBtn: {
    padding: '10px 14px',
    borderRadius: 8,
    border: '1px solid #ddd',
    background: '#fff',
    color: '#333',
  },
  thumbCell: {
    position: 'relative',
    borderRadius: 8,
    overflow: 'hidden',
    border: '1px solid #eee',
    background: '#f7f7f7',
    aspectRatio: '1 / 1',
  },
  thumbImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  thumbOps: {
    position: 'absolute',
    inset: 6,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'start',
  },
  iconBtn: {
    border: '1px solid #ddd',
    background: 'rgba(255,255,255,0.9)',
    padding: '2px 6px',
    borderRadius: 6,
    cursor: 'pointer',
  },
  previewBox: {
    position: 'relative',
    width: '100%',
    maxWidth: 900,
    margin: '0 auto',
    background: '#fff',
    padding: 12,
    borderRadius: 16,
    border: '1px solid #eee',
  },
};

const amStyles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  modal: {
    width: 'min(960px, 92vw)',
    maxHeight: '86vh',
    overflow: 'auto',
    background: '#fff',
    borderRadius: 12,
    border: '1px solid #e7e7e7',
    boxShadow: '0 12px 40px rgba(0,0,0,0.2)',
    padding: 12,
  },
  head: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  iconBtn: {
    border: '1px solid #ddd',
    background: '#fff',
    padding: '4px 8px',
    borderRadius: 6,
    cursor: 'pointer',
  },
  hint: { padding: 16, color: '#666' },
  sliderRow: { display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 12px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 },
  cell: {
    position: 'relative',
    display: 'block',
    border: '1px solid #eee',
    borderRadius: 10,
    overflow: 'hidden',
    background: '#fafafa',
    cursor: 'pointer',
  },
  check: { position: 'absolute', top: 8, left: 8 },
  thumb: {
    width: '100%',
    height: 'var(--thumb, 120px)' as any,
    objectFit: 'cover',
    display: 'block',
  },
  name: {
    fontSize: 12,
    padding: '6px 8px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    borderTop: '1px solid #eee',
    background: '#fff',
  },
  footer: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 },
  primaryBtn: {
    padding: '10px 14px',
    borderRadius: 8,
    border: '1px solid #6b5bfa',
    background: 'linear-gradient(180deg, #8f7dff 0%, #6b5bfa 100%)',
    color: '#fff',
    cursor: 'pointer',
    boxShadow: '0 6px 18px rgba(122, 101, 255, 0.25)',
  },
  secondaryBtn: {
    padding: '10px 14px',
    borderRadius: 8,
    border: '1px solid #ddd',
    background: '#fff',
    color: '#333',
  },
};
