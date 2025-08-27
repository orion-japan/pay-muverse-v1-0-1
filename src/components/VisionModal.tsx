'use client';

import { useEffect, useState, useCallback } from 'react';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import { supabase } from '@/lib/supabase';
import IboardPicker from './IboardPicker';
import VisionResultCard from './VisionResultCard';
import './VisionModal.css';

import type { Vision, Phase, Stage, Status } from '@/types/vision';
import { resizeImage } from '@/utils/imageResize'; // ← 既存ユーティリティは無改変で使う
import { useAuth } from '@/context/AuthContext';   // ★ 追加：数値 userCode フォールバック用

type VisionModalProps = {
  isOpen: boolean;
  defaultPhase: Phase;
  defaultStage: Stage;
  userCode: string;          // ← 親から渡る（UIDのこともある）
  initial?: Vision | null;
  onClose: () => void;
  onSaved?: (saved: any) => void;
};

const STATUS_LIST: Status[] = ['検討中', '実践中', '迷走中', '順調', 'ラストスパート', '達成', '破棄'];

/* ==== 橋渡しチェック デフォルト ==== */
function nextStageOf(s: Stage): Stage | null {
  const order: Stage[] = ['S', 'F', 'R', 'C', 'I'];
  const i = order.indexOf(s);
  return i >= 0 && i < order.length - 1 ? order[i + 1] : null;
}
function defaultCriteria(from: Stage, to: Stage, vision_id: string) {
  if (from === 'S' && to === 'F') {
    return [
      { vision_id, from_stage: 'S', to_stage: 'F', title: '意図メモを3つ書く', required_days: 3, required: true, order_index: 0 },
      { vision_id, from_stage: 'S', to_stage: 'F', title: 'iBoardに1回投稿', required_days: 1, required: true, order_index: 1 },
    ];
  }
  if (from === 'F' && to === 'R') {
    return [
      { vision_id, from_stage: 'F', to_stage: 'R', title: '関連メモを5つ集める', required_days: 5, required: true, order_index: 0 },
      { vision_id, from_stage: 'F', to_stage: 'R', title: '週のまとめを1回書く', required_days: 1, required: true, order_index: 1 },
    ];
  }
  if (from === 'R' && to === 'C') {
    return [{ vision_id, from_stage: 'R', to_stage: 'C', title: '実行タスクを3件切る', required_days: 3, required: true, order_index: 0 }];
  }
  if (from === 'C' && to === 'I') {
    return [
      { vision_id, from_stage: 'C', to_stage: 'I', title: '今週2回実行する', required_days: 2, required: true, order_index: 0 },
      { vision_id, from_stage: 'C', to_stage: 'I', title: '成果を1回共有する', required_days: 1, required: true, order_index: 1 },
    ];
  }
  return [];
}
async function seedStageCriteria(vision_id: string, from_stage: Stage, token: string) {
  const to = nextStageOf(from_stage);
  if (!to) return;
  const bulk = defaultCriteria(from_stage, to, vision_id);
  if (bulk.length === 0) return;
  const res = await fetch('/api/vision-criteria', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ bulk }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.warn('seedStageCriteria failed:', res.status, t);
  }
}

/* ==================== 画像選択（Album / IBoard / Upload） ==================== */
type PickerTab = 'album' | 'iboard' | 'upload';
type AlbumItem = {
  name: string;
  url: string;   // 表示用（署名URL）
  path: string;  // private-posts バケット内パス
  size?: number | null;
  updated_at?: string | null;
};

// 🔸 既存 resizeImage に合わせて「Blob or { blob }」両対応の薄いアダプタ
type ResizeRet = Blob | { blob: Blob; width?: number; height?: number; type?: string };
async function resizeAsObject(
  file: File,
  opts: any
): Promise<{ blob: Blob; width?: number; height?: number; type?: string }> {
  const r: ResizeRet = await (resizeImage as any)(file, opts);
  if (r instanceof Blob) return { blob: r, type: r.type };
  return r;
}

/** Private Album 用：list + 署名URL化（※バケットは private-posts / パスは <userCode>/） */
async function listAlbumImages(userCode: string): Promise<AlbumItem[]> {
  try {
    const ucode = (userCode || '').trim();
    if (!ucode) return [];
    const prefix = `${ucode}`;
    const { data, error } = await supabase.storage.from('private-posts').list(prefix, {
      limit: 100,
      sortBy: { column: 'updated_at', order: 'desc' },
    });
    if (error) throw error;

    const files = (data || []).filter((f) => !f.name.startsWith('.') && !f.name.endsWith('/'));
    const resolved = await Promise.all(
      files.map(async (f) => {
        const path = `${prefix}/${f.name}`;
        const { data: signed } = await supabase.storage.from('private-posts').createSignedUrl(path, 60 * 30);
        return {
          name: f.name,
          url: signed?.signedUrl ?? '',
          path,
          size: (f as any)?.metadata?.size ?? null,
          updated_at: (f as any)?.updated_at ?? null,
        };
      })
    );
    return resolved;
  } catch (e) {
    console.warn('listAlbumImages error:', e);
    return [];
  }
}

/** album://path または 直URL をプレビュー用に解決（モーダル内画像プレビューで使用） */
function useResolvedThumb(raw?: string | null) {
  const [url, setUrl] = useState<string | null>(null);

  // バケット名はここで固定（他所でも同じ定数を使うと事故らない）
  const ALBUM_BUCKET = 'private-posts';

  useEffect(() => {
    let canceled = false;

    (async () => {
      // 何もなければクリア
      if (!raw) {
        if (!canceled) setUrl(null);
        return;
      }

      // album://<userCode>/<filename> を署名URLに解決
      if (raw.startsWith('album://')) {
        try {
          // 'album://' を外す
          let path = raw.replace(/^album:\/\//, '');

          // 先頭に余計なスラッシュが付いていたら除去
          path = path.replace(/^\/+/, '');

          // たまに path に 'private-posts/' が混入してくるケースがあるので剥がす
          // 例: album://private-posts/669933/xxx.webp → 669933/xxx.webp に矯正
          path = path.replace(new RegExp(`^(?:${ALBUM_BUCKET}/)+`), '');

          const { data, error } = await supabase
            .storage
            .from(ALBUM_BUCKET)
            .createSignedUrl(path, 60 * 60); // 1h

          if (canceled) return;

          if (error) {
            console.warn('createSignedUrl error:', error, { bucket: ALBUM_BUCKET, path });
            setUrl(null);
          } else {
            setUrl(data?.signedUrl ?? null);
          }
        } catch (e) {
          if (!canceled) {
            console.warn('useResolvedThumb unexpected error:', e);
            setUrl(null);
          }
        }
        return;
      }

      // 直URL（http/https/data/blob等）はそのまま
      if (!canceled) setUrl(raw);
    })();

    return () => {
      canceled = true;
    };
  }, [raw]);

  return url;
}

/* ==================== 本体 ==================== */
export default function VisionModal({
  isOpen,
  defaultPhase,
  defaultStage,
  userCode,
  initial,
  onClose,
  onSaved,
}: VisionModalProps) {
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  // ★ 追加：渡ってきた userCode が UID っぽい場合は AuthContext の数値 userCode を優先
  const { userCode: authUserCode } = useAuth();
  const effectiveUserCode = (() => {
    const prop = (userCode || '').trim();
    if (/^\d+$/.test(prop)) return prop;         // すでに数値ならそのまま
    if (authUserCode != null) return String(authUserCode).trim(); // 数値 userCode に差し替え
    return prop;                                  // 最後の手段（空/UID）でも動かす
  })();

  const [vision, setVision] = useState<Vision>(() => ({
    phase: initial?.phase ?? defaultPhase,
    stage: initial?.stage ?? defaultStage, // 表示上は維持。保存時に新規は 'S' に矯正
    title: initial?.title ?? '',
    detail: initial?.detail ?? '',
    intention: initial?.intention ?? '',
    supplement: initial?.supplement ?? '',
    status: (initial?.status as Status) ?? '検討中',
    summary: initial?.summary ?? '',
    iboard_post_id: initial?.iboard_post_id ?? null,
    iboard_thumb: initial?.iboard_thumb ?? null, // album://path or 直URL
    q_code: initial?.q_code ?? undefined,
    vision_id: initial?.vision_id,
  }));

  // 画像選択タブ
  const [pickerTab, setPickerTab] = useState<PickerTab>('album');
  const [albumLoading, setAlbumLoading] = useState(false);
  const [albumItems, setAlbumItems] = useState<AlbumItem[]>([]);
  const [thumbSize, setThumbSize] = useState<number>(50);
  const [uploading, setUploading] = useState(false);

  // モーダル内のプレビュー用URL（画像枠）
  const resolvedThumb = useResolvedThumb(vision.iboard_thumb ?? null);

  /* ---------------- Auth 初期化 ---------------- */
  useEffect(() => {
    const auth = getAuth();
    return onAuthStateChanged(auth, () => setAuthReady(true));
  }, []);

  /* ---------------- 初期値反映 ---------------- */
  useEffect(() => {
    if (!isOpen || !initial) return;
    setVision((v) => ({
      ...v,
      phase: initial.phase,
      stage: initial.stage,
      title: initial.title,
      detail: initial.detail ?? '',
      intention: initial.intention ?? '',
      supplement: initial.supplement ?? '',
      status: (initial.status as Status) ?? '検討中',
      summary: initial.summary ?? '',
      iboard_post_id: initial.iboard_post_id ?? null,
      iboard_thumb: initial.iboard_thumb ?? null,
      q_code: initial.q_code ?? undefined,
      vision_id: initial.vision_id,
    }));
  }, [isOpen, initial]);

  /* ---------------- Albumタブが開かれたら読み込み（private-posts/<userCode>/） ---------------- */
  useEffect(() => {
    if (!isOpen) return;
    if (pickerTab !== 'album') return;
    const ucode = (effectiveUserCode || '').trim();
    if (!ucode) return; // userCode 未取得時は読まない
    let alive = true;
    (async () => {
      setAlbumLoading(true);
      try {
        const items = await listAlbumImages(ucode);
        if (alive) setAlbumItems(items);
      } finally {
        if (alive) setAlbumLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isOpen, pickerTab, effectiveUserCode]);

  /* ---------------- ESC / Cmd+Enter ---------------- */
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') onClose();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'enter') {
        e.preventDefault();
        if (!saving) void handleSave();
      }
    },
    [isOpen, saving] // eslint-disable-line
  );
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, handleKey]);

  if (!isOpen) return null;

  const handleChange = (k: keyof Vision, val: any) => setVision((prev) => ({ ...prev, [k]: val }));

  // 共通：サムネを反映＋アニメ
  const setThumbAndPulse = (thumbRaw: string | null, postId: string | null = null) => {
    setVision((prev) => ({ ...prev, iboard_post_id: postId, iboard_thumb: thumbRaw }));
    const el = document.querySelector('.vmd-thumb');
    el?.classList.add('pulse-once');
    setTimeout(() => el?.classList.remove('pulse-once'), 900);
  };

  // IBoard から選択（公開：public-posts側。IboardPickerは本人投稿のみ表示前提）
  const handlePickIboard = (postId: string, thumbUrl: string) => {
    setThumbAndPulse(thumbUrl, postId);
  };

  // Album の画像を選択（保存値は album://path）
  const handlePickAlbum = (item: AlbumItem) => {
    setThumbAndPulse(`album://${item.path}`, null);
  };

  // 画像アップロード（private-posts/<userCode>/ にリサイズ保存 → album://path を保存）
  const handleUploadFile = async (file: File) => {
    try {
      setUploading(true);
      setErrorMsg(null);

      const ucode = (effectiveUserCode || '').trim();
      if (!ucode) {
        setErrorMsg('ユーザーコード取得前のためアップロードできません。しばらくしてからお試しください。');
        return;
      }

      const auth = getAuth();
      if (!auth.currentUser) await signInAnonymously(auth);

      // リサイズ（元の resizeImage に合わせてアダプタ経由）
      const { blob } = await resizeAsObject(file, { max: 1600, type: 'image/webp', quality: 0.9 });

      const safeName = file.name.replace(/[^\w.\-]+/g, '_').replace(/\.[^.]+$/, '.webp');
      const path = `${ucode}/${Date.now()}_${safeName}`;

      const { error: upErr } = await supabase.storage.from('private-posts').upload(path, blob, {
        cacheControl: '3600',
        upsert: true,
        contentType: 'image/webp',
      });
      if (upErr) throw upErr;

      // 一覧表示用に短命URLを作っておく
      const { data: signed } = await supabase.storage.from('private-posts').createSignedUrl(path, 60 * 30);

      // 保存値は album://path（失効しない）
      setThumbAndPulse(`album://${path}`, null);

      // Albumタブの一覧を即時更新
      setAlbumItems((prev) => [
        { name: safeName, url: signed?.signedUrl ?? '', path, size: blob.size, updated_at: new Date().toISOString() },
        ...prev,
      ]);

      // 視覚的に分かりやすく album タブへ戻す
      setPickerTab('album');
    } catch (e: any) {
      console.error('upload error:', e);
      setErrorMsg(e?.message || 'アップロードに失敗しました');
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    try {
      const auth = getAuth();
      if (!auth.currentUser) await signInAnonymously(auth);
      const token = await auth.currentUser!.getIdToken();

      if (!vision.title?.trim()) {
        setErrorMsg('タイトルを入力してください');
        return;
      }

      setSaving(true);
      setErrorMsg(null);

      const isUpdate = Boolean(vision.vision_id);
      const method = isUpdate ? 'PUT' : 'POST';
      const stageForSave: Stage = isUpdate ? (vision.stage as Stage) : 'S'; // ★新規は必ずS

      const payload = {
        vision_id: vision.vision_id,
        phase: vision.phase,
        stage: stageForSave,
        title: vision.title,
        detail: vision.detail,
        intention: vision.intention,
        supplement: vision.supplement,
        status: vision.status,
        summary: vision.summary,
        iboard_post_id: vision.iboard_post_id,   // Album/Uploadは null のまま
        iboard_thumb: vision.iboard_thumb,       // album://path or 直URL
        q_code: vision.q_code,
      };

      const res = await fetch('/api/visions', {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        const msg = (data && (data.error as string)) || `保存に失敗しました (${res.status})`;
        throw new Error(msg);
      }

      if (!isUpdate && data?.vision_id) {
        try {
          await seedStageCriteria(String(data.vision_id), 'S', token);
        } catch (e) {
          console.warn('seed criteria warn:', e);
        }
      }

      onSaved?.(data);
      onClose();
    } catch (e: any) {
      console.error('Vision save error:', e);
      setErrorMsg(e?.message || 'エラーが発生しました');
    } finally {
      setSaving(false);
    }
  };

  /* ===== q_code を文字列に正規化（カードに渡す直前で） ===== */
  const qCodeForCard =
    typeof vision.q_code === 'string'
      ? vision.q_code
      : vision.q_code && typeof (vision.q_code as any).code === 'string'
      ? (vision.q_code as any).code
      : null;

  /* ==================== レンダリング ==================== */
  return (
    <div className="vmd-backdrop" role="dialog" aria-modal="true">
      <div className="vmd-modal">
        {/* ヘッダー */}
        <div className="vmd-header">
          <div className="vmd-title">
            {vision.vision_id ? 'Visionを編集' : 'Visionを作成'}
            <span className="vmd-title-sparkle" aria-hidden />
          </div>
          <button className="vmd-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        {/* 本文 */}
        <div className="vmd-body">
          {/* タイトル */}
          <label className="vmd-label">タイトル（ビジョン）</label>
          <input
            className="vmd-input"
            value={vision.title}
            onChange={(e) => handleChange('title', e.target.value)}
            placeholder="例：鳥になりたい"
          />

          {/* 画像 */}
          <div className="vmd-image-block">
            <div className="vmd-preview">
              {resolvedThumb ? (
                <>
                  <img src={resolvedThumb} alt="" className="vmd-thumb" />
                  <span className="vmd-chip">選択済み</span>
                </>
              ) : (
                <div className="vmd-thumb placeholder">
                  <span className="vmd-spark">画像を選ぶとここがキラッ ✨</span>
                </div>
              )}
            </div>

            <div className="vmd-pick">
              {/* タブ切替 */}
              <div className="vmd-pick-tabs" role="tablist" aria-label="画像の選択方法">
                <button
                  className={`vmd-tab ${pickerTab === 'album' ? 'active' : ''}`}
                  onClick={() => setPickerTab('album')}
                  role="tab"
                  aria-selected={pickerTab === 'album'}
                >
                  Album
                </button>
                <button
                  className={`vmd-tab ${pickerTab === 'iboard' ? 'active' : ''}`}
                  onClick={() => setPickerTab('iboard')}
                  role="tab"
                  aria-selected={pickerTab === 'iboard'}
                >
                  IBoard
                </button>
                <button
                  className={`vmd-tab ${pickerTab === 'upload' ? 'active' : ''}`}
                  onClick={() => setPickerTab('upload')}
                  role="tab"
                  aria-selected={pickerTab === 'upload'}
                >
                  アップロード
                </button>
              </div>

              {/* サムネサイズスライダー */}
              <div className="vmd-thumbsize">
                <span className="vmd-thumbsize-label">サムネ</span>
{/* サムネサイズスライダー */}
<input
  type="range"
 min={40}        // ★ 初期値50より小さい値に
  max={160}
 step={5}        // （任意）手触り改善
  value={thumbSize}
  onChange={(e) => setThumbSize(Number(e.target.value))}
/>
                <span className="vmd-thumbsize-val">{thumbSize}px</span>
              </div>

              {/* タブ内容 */}
              <div className="vmd-pick-pane">
                {pickerTab === 'album' && (
                  <div className="album-pane">
                    {!effectiveUserCode?.trim() ? (
                      <div className="vmd-hint">ユーザーコードを取得中です…（少し待ってから再度お試しください）</div>
                    ) : albumLoading ? (
                      <div className="vmd-hint">読み込み中…</div>
                    ) : albumItems.length === 0 ? (
                      <div className="vmd-hint">アルバムに画像がありません。右の「アップロード」から追加できます。</div>
                    ) : (
<div className="vmd-grid" style={{ ['--thumb' as any]: `${thumbSize}px` }}>
  {albumItems.map((it) => (
    <button key={it.path} className="vmd-thumb-btn" onClick={() => handlePickAlbum(it)} title={it.name}>
      <img src={it.url} alt={it.name} />
    </button>
  ))}
</div>

                    )}
                  </div>
                )}

                {pickerTab === 'iboard' && (
                  <div className="iboard-pane">
                    <IboardPicker
                      userCode={effectiveUserCode}
                      selectedPostId={vision.iboard_post_id ?? undefined}
                      onSelect={handlePickIboard}
                      thumbSizePx={thumbSize}
                    />
                  </div>
                )}

                {pickerTab === 'upload' && (
                  <div className="upload-pane">
                    <div className="vmd-upload-row">
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          const f = e.currentTarget.files?.[0];
                          if (f) void handleUploadFile(f);
                          e.currentTarget.value = '';
                        }}
                        disabled={uploading}
                      />
                      {uploading && <span className="vmd-hint">アップロード中…</span>}
                    </div>
                    <div className="vmd-hint small">
                      バケット: <code>private-posts</code> / フォルダ: <code>{(effectiveUserCode || '').trim()}/</code>（Private・表示は署名URL）
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ---- プレビュー：VisionResultCard（status バッジ反映） ---- */}
          <div style={{ marginTop: 12, marginBottom: 8 }}>
            <VisionResultCard
              visionId={vision.vision_id ?? 'new'}
              title={vision.title || '(無題)'}
              phase={'initial' as any}
              resultStatus={'成功' as any}
              resultedAt={new Date().toISOString()}
              userCode={effectiveUserCode}
              qCode={qCodeForCard}
              thumbnailUrl={vision.iboard_thumb ?? null}
              visionStatus={vision.status as any}
            />
          </div>

          {/* 詳細群 */}
          <label className="vmd-label">詳細</label>
          <textarea
            className="vmd-textarea"
            rows={3}
            value={vision.detail}
            onChange={(e) => handleChange('detail', e.target.value)}
            placeholder="どんな状態を目指す？"
          />

          <label className="vmd-label">意図メモ</label>
          <textarea
            className="vmd-textarea"
            rows={3}
            value={vision.intention}
            onChange={(e) => handleChange('intention', e.target.value)}
            placeholder="なぜやりたい？"
          />

          <label className="vmd-label">補足</label>
          <textarea
            className="vmd-textarea"
            rows={2}
            value={vision.supplement}
            onChange={(e) => handleChange('supplement', e.target.value)}
            placeholder="共有したいことや注意点"
          />

          {/* ステータス */}
          <div className="vmd-row">
            <div className="vmd-col">
              <label className="vmd-label">ステータス</label>
              <select
                className="vmd-select"
                value={vision.status}
                onChange={(e) => handleChange('status', e.target.value as Status)}
              >
                {STATUS_LIST.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 総評 */}
          <label className="vmd-label">総評</label>
          <textarea
            className="vmd-textarea"
            rows={3}
            value={vision.summary}
            onChange={(e) => handleChange('summary', e.target.value)}
            placeholder="短くまとめ（後からでOK）"
          />

          {errorMsg && <div className="vmd-error">⚠ {errorMsg}</div>}
        </div>

        {/* フッター */}
        <div className="vmd-footer">
          <button className="vmd-btn ghost" onClick={onClose}>
            キャンセル（Esc）
          </button>
          <button
            className="vmd-btn primary"
            onClick={handleSave}
            disabled={saving || !authReady || !vision.title?.trim()}
            title={!authReady ? '認証初期化中…' : 'Ctrl/⌘+Enter で保存'}
          >
            <span className="btn-gloss" aria-hidden />
            {saving ? '保存中…' : '保存する'}
          </button>
        </div>
      </div>
    </div>
  );
}
