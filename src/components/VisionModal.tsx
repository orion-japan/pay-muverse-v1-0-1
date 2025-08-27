'use client';

import { useEffect, useState, useCallback } from 'react';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import { supabase } from '@/lib/supabase';
import IboardPicker from './IboardPicker';
import VisionResultCard from './VisionResultCard';
import './VisionModal.css';

import type { Vision, Phase, Stage, Status } from '@/types/vision';

/* ==== バケット（環境に合わせてここだけ変えればOK） ==== */
const BUCKET_PRIVATE = 'private-posts'; // ← Album（プライベート）
const BUCKET_PUBLIC  = 'public-posts';  // ← IBoard（公開） ※このファイルでは参照のみ

type VisionModalProps = {
  isOpen: boolean;
  defaultPhase: Phase;
  defaultStage: Stage;
  userCode: string;
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
  path: string;  // BUCKET_PRIVATE 内のパス
  size?: number | null;
  updated_at?: string | null;
};

/** Private album 用：list + 署名URL化（バケット名を private-posts に統一） */
async function listAlbumImages(userCode: string): Promise<AlbumItem[]> {
  try {
    const prefix = `${userCode}`;
    const { data, error } = await supabase.storage.from(BUCKET_PRIVATE).list(prefix, {
      limit: 100,
      sortBy: { column: 'updated_at', order: 'desc' },
    });
    if (error) throw error;

    const files = (data || []).filter((f) => !f.name.startsWith('.') && !f.name.endsWith('/'));
    const resolved = await Promise.all(
      files.map(async (f) => {
        const path = `${prefix}/${f.name}`;
        const { data: signed } = await supabase.storage.from(BUCKET_PRIVATE).createSignedUrl(path, 60 * 30);
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

  useEffect(() => {
    let canceled = false;
    (async () => {
      if (!raw) {
        setUrl(null);
        return;
      }
      if (raw.startsWith('album://')) {
        const path = raw.replace(/^album:\/\//, '');
        const { data, error } = await supabase.storage.from(BUCKET_PRIVATE).createSignedUrl(path, 60 * 60);
        if (!canceled) setUrl(error ? null : data?.signedUrl ?? null);
        return;
      }
      setUrl(raw);
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
  const [thumbSize, setThumbSize] = useState<number>(100);
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

  /* ---------------- Albumタブが開かれたら読み込み ---------------- */
  useEffect(() => {
    if (!isOpen) return;
    if (pickerTab !== 'album') return;
    let alive = true;
    (async () => {
      setAlbumLoading(true);
      const items = await listAlbumImages(userCode);
      if (alive) setAlbumItems(items);
      setAlbumLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [isOpen, pickerTab, userCode]);

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
    [isOpen, saving]
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

  // IBoard から選択（公開＝public-posts） → IboardPicker 側に任せる
  const handlePickIboard = (postId: string, thumbUrl: string) => {
    setThumbAndPulse(thumbUrl, postId);
  };

  // Album の画像を選択（保存値は album://path）
  const handlePickAlbum = (item: AlbumItem) => {
    setThumbAndPulse(`album://${item.path}`, null);
  };

  // 画像アップロード（private-posts/userCode/ に保存 → album://path を保存）
  const handleUploadFile = async (file: File) => {
    try {
      setUploading(true);
      setErrorMsg(null);

      const auth = getAuth();
      if (!auth.currentUser) await signInAnonymously(auth);

      const safeName = file.name.replace(/[^\w.\-]+/g, '_');
      const path = `${userCode}/${Date.now()}_${safeName}`;

      const { error: upErr } = await supabase.storage.from(BUCKET_PRIVATE).upload(path, file, {
        cacheControl: '3600',
        upsert: true,
        contentType: file.type || 'image/*',
      });
      if (upErr) throw upErr;

      // 一覧表示用に短命URLを作っておく
      const { data: signed } = await supabase.storage.from(BUCKET_PRIVATE).createSignedUrl(path, 60 * 30);

      // 保存値は album://path（失効しない）
      setThumbAndPulse(`album://${path}`, null);

      // Albumタブの一覧を即時更新
      setAlbumItems((prev) => [
        { name: safeName, url: signed?.signedUrl ?? '', path, size: file.size, updated_at: new Date().toISOString() },
        ...prev,
      ]);

      // 視覚的に分かりやすく album タブへ戻す
      setPickerTab('album');
    } catch (e: any) {
      console.error('upload error:', e);
      setErrorMsg(e?.message || 'アップロードに失敗しました（バケット名や権限を確認してください）');
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
      const stageForSave: Stage = isUpdate ? (vision.stage as Stage) : 'S';

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
        iboard_post_id: vision.iboard_post_id, // Album/Upload は null のまま
        iboard_thumb: vision.iboard_thumb,     // album://path or 直URL
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
          <button className="vmd-close" onClick={onClose} aria-label="閉じる">×</button>
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
                <button className={`vmd-tab ${pickerTab === 'album' ? 'active' : ''}`} onClick={() => setPickerTab('album')} role="tab" aria-selected={pickerTab === 'album'}>Album</button>
                <button className={`vmd-tab ${pickerTab === 'iboard' ? 'active' : ''}`} onClick={() => setPickerTab('iboard')} role="tab" aria-selected={pickerTab === 'iboard'}>IBoard</button>
                <button className={`vmd-tab ${pickerTab === 'upload' ? 'active' : ''}`} onClick={() => setPickerTab('upload')} role="tab" aria-selected={pickerTab === 'upload'}>アップロード</button>
              </div>

              {/* サムネサイズスライダー（共通） */}
              <div className="vmd-thumbsize">
                <span className="vmd-thumbsize-label">サムネ</span>
                <input type="range" min={60} max={160} value={thumbSize} onChange={(e) => setThumbSize(Number(e.target.value))} />
                <span className="vmd-thumbsize-val">{thumbSize}px</span>
              </div>

              {/* タブ内容 */}
              <div className="vmd-pick-pane">
                {pickerTab === 'album' && (
                  <div className="album-pane">
                    {albumLoading ? (
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
                    {/* 既存の IboardPicker（= public-posts）。内部タブはCSSで非表示にします */}
                    <IboardPicker
                      userCode={userCode}
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
                      バケット: <code>{BUCKET_PRIVATE}</code> / フォルダ: <code>{userCode}/</code>（Private：表示は署名URL）
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* プレビュー（カード） */}
          <div style={{ marginTop: 12, marginBottom: 8 }}>
            <VisionResultCard
              visionId={vision.vision_id ?? 'new'}
              title={vision.title || '(無題)'}
              phase={'initial' as any}
              resultStatus={'成功' as any}
              resultedAt={new Date().toISOString()}
              userCode={userCode}
              qCode={qCodeForCard}
              thumbnailUrl={vision.iboard_thumb ?? null}
              visionStatus={vision.status as any}
            />
          </div>

          {/* 詳細群 */}
          <label className="vmd-label">詳細</label>
          <textarea className="vmd-textarea" rows={3} value={vision.detail} onChange={(e) => handleChange('detail', e.target.value)} placeholder="どんな状態を目指す？" />

          <label className="vmd-label">意図メモ</label>
          <textarea className="vmd-textarea" rows={3} value={vision.intention} onChange={(e) => handleChange('intention', e.target.value)} placeholder="なぜやりたい？" />

          <label className="vmd-label">補足</label>
          <textarea className="vmd-textarea" rows={2} value={vision.supplement} onChange={(e) => handleChange('supplement', e.target.value)} placeholder="共有したいことや注意点" />

          {/* ステータス */}
          <div className="vmd-row">
            <div className="vmd-col">
              <label className="vmd-label">ステータス</label>
              <select className="vmd-select" value={vision.status} onChange={(e) => handleChange('status', e.target.value as Status)}>
                {STATUS_LIST.map((s) => (<option key={s} value={s}>{s}</option>))}
              </select>
            </div>
          </div>

          {/* 総評 */}
          <label className="vmd-label">総評</label>
          <textarea className="vmd-textarea" rows={3} value={vision.summary} onChange={(e) => handleChange('summary', e.target.value)} placeholder="短くまとめ（後からでOK）" />

          {errorMsg && <div className="vmd-error">⚠ {errorMsg}</div>}
        </div>

        {/* フッター */}
        <div className="vmd-footer">
          <button className="vmd-btn ghost" onClick={onClose}>キャンセル（Esc）</button>
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
