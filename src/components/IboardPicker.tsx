'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import './IboardPicker.css';

type IboardPost = {
  post_id: string;
  media_urls: any[] | null; // string[] or { url: string }[]
  user_code?: string | null;
  visibility?: string | null;
  board_type?: string | null;
  created_at?: string | null;
};

type AlbumItem = { id: string; url: string; path: string };

type IboardPickerProps = {
  /** ログイン中ユーザーの user_code（空でもOK） */
  userCode: string;
  /** 任意：表示名（未使用でもOK） */
  clickUsername?: string;
  selectedPostId?: string | null;
  onSelect: (postId: string, thumbnailUrl: string) => void;
  onClose?: () => void;
  /** iBoard サムネ1辺(px)。未指定なら 100 */
  thumbSizePx?: number;
  /** 取得上限 */
  limit?: number;
  /** Storage の公開バケット名 */
  bucketName?: string;
  /** ★ 追加: スコープ（既定は 'mine' = 自分の投稿のみ）。'all' で全体表示に切替可 */
  scope?: 'mine' | 'all';
};

export default function IboardPicker({
  userCode,
  clickUsername,
  selectedPostId,
  thumbSizePx,
  onSelect,
  onClose,
  limit = 200,
  bucketName = 'public',
  scope = 'mine', // ★ 既定で「自分の投稿のみ」
}: IboardPickerProps) {
  // ---- UI 状態 ----
  const [tab, setTab] = useState<'iboard' | 'album'>('iboard');
  const [thumb, setThumb] = useState<number>(thumbSizePx ?? 100); // ← propを初期値に反映
  const [current, setCurrent] = useState<string | null>(selectedPostId ?? null);

  // propでサイズが変わったら追従
  useEffect(() => {
    if (typeof thumbSizePx === 'number') setThumb(thumbSizePx);
  }, [thumbSizePx]);

  // ---- データ状態 ----
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [posts, setPosts] = useState<IboardPost[]>([]); // iBoard
  const [album, setAlbum] = useState<AlbumItem[]>([]);  // Album(Storage)
  const [uploading, setUploading] = useState(false);

  const me = (userCode ?? '').trim();

  const normalizeUrl = (u: any) => (typeof u === 'string' ? u : u?.url || '');

  /* =========================
      iBoard 取得
  ========================= */
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (tab !== 'iboard') return;
      setLoading(true);
      setErrorMsg(null);
      try {
        // ベースクエリ
        let q = supabase
          .from('posts')
          .select('post_id, media_urls, user_code, visibility, board_type, created_at')
          .order('created_at', { ascending: false })
          .limit(limit);

        // ★ スコープが 'mine' のときは必ず「自分の投稿のみ」
        if (scope === 'mine' && me) {
          q = q.eq('user_code', me);
        }

        const { data, error } = await q;
        if (error) throw error;
        if (!mounted) return;

        // 画像つき、かつ private-posts ではないもの
        const hasImage = (p: any) =>
          Array.isArray(p.media_urls) &&
          p.media_urls.length > 0 &&
          p.media_urls.every((raw: any) => {
            const url = normalizeUrl(raw);
            return url && !url.includes('/private-posts/');
          });

        const filtered = (data ?? []).filter(hasImage);

        // ★ 以前の「自分が0件なら全体からフォールバック」は廃止
        //   => 実行カード側では“本当に自分の投稿だけ”に限定される
        const show = filtered.map((p: any) => ({
          post_id: p.post_id as string,
          media_urls: Array.isArray(p.media_urls) ? p.media_urls : [],
          user_code: p.user_code ?? null,
          visibility: p.visibility ?? null,
          board_type: p.board_type ?? null,
          created_at: p.created_at ?? null,
        }));

        setPosts(show);
      } catch (e: any) {
        setErrorMsg(e?.message || 'iBoardの読み込みに失敗しました');
      } finally {
        setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [tab, userCode, clickUsername, limit, scope]);

  /* =========================
      Album(Storage) 取得
  ========================= */
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (tab !== 'album') return;
      setLoading(true);
      setErrorMsg(null);
      try {
        const prefixes: string[] = [];
        // userCode あり/なし の両方を走査（パス設計が揺れていても拾える）
        const withUser = me ? [`album/${me}/`, `iboard/${me}/`, `uploads/${me}/`] : [];
        const noUser   = [`album/`, `iboard/`, `uploads/`];
        withUser.forEach((p) => prefixes.push(p));
        noUser.forEach((p) => prefixes.push(p));

        const items: AlbumItem[] = [];
        for (const prefix of prefixes) {
          const { data, error } = await supabase.storage
            .from(bucketName)
            .list(prefix, { limit: 100, offset: 0, sortBy: { column: 'created_at', order: 'desc' } });
          if (error) continue;

          for (const f of data || []) {
            const name = (f.name || '').toLowerCase();
            if (!/\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(name)) continue;
            const path = `${prefix}${f.name}`;
            const { data: pub } = supabase.storage.from(bucketName).getPublicUrl(path);
            if (!pub?.publicUrl) continue;
            items.push({ id: `album:${path}`, path, url: pub.publicUrl });
          }
        }

        if (!mounted) return;
        setAlbum(items);
      } catch (e: any) {
        setErrorMsg(e?.message || 'アルバムの読み込みに失敗しました');
      } finally {
        setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [tab, userCode, bucketName, me]);

  /* =========================
      Album その場アップロード
  ========================= */
  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setUploading(true);
      setErrorMsg(null);
      const base = me ? `album/${me}/` : `album/`;
      const path = `${base}${Date.now()}_${file.name}`;
      const up = await supabase.storage.from(bucketName).upload(path, file, { upsert: false });
      if (up.error) throw up.error;
      const { data: pub } = supabase.storage.from(bucketName).getPublicUrl(path);
      if (!pub?.publicUrl) throw new Error('公開URLを取得できませんでした');

      // 即選択
      const id = `album:${path}`;
      onSelect(id, pub.publicUrl);
      setCurrent(id);
      setAlbum((prev) => [{ id, path, url: pub.publicUrl }, ...prev]);
    } catch (e: any) {
      setErrorMsg(e?.message || 'アップロードに失敗しました');
    } finally {
      setUploading(false);
      e.currentTarget.value = '';
    }
  }

  /* =========================
      クリック選択
  ========================= */
  const selectIboard = (p: IboardPost) => {
    const urls = Array.isArray(p.media_urls)
      ? p.media_urls.map((u: any) => (typeof u === 'string' ? u : u?.url || '')).filter(Boolean)
      : [];
    const thumbUrl = urls[0] || '';
    setCurrent(p.post_id);
    onSelect(p.post_id, thumbUrl);
  };

  const selectAlbum = (it: AlbumItem) => {
    setCurrent(it.id);
    onSelect(it.id, it.url);
  };

  /* =========================
      UI
  ========================= */
  return (
    <div className="ibp-shell" style={{ ['--thumb' as any]: `${thumb}px` }}>
      <div className="ibp-header">
        <div className="ibp-title">画像を選択</div>
        {/* デバッグ表示（不要なら削除OK） */}
        <div className="ibp-debug">
          userCode: <code>{me || '(empty)'}</code> ｜ iBoard: {posts.length} ｜ Album: {album.length}
        </div>
        {onClose && (
          <button type="button" className="ibp-close" onClick={onClose} aria-label="閉じる">×</button>
        )}
      </div>

      {/* 表示設定（タブ＋サムネサイズ） */}
      <div className="ibp-controls">
        <div className="ibp-tabs">
          <button
            className={`ibp-tab ${tab === 'iboard' ? 'active' : ''}`}
            onClick={() => setTab('iboard')}
            aria-pressed={tab === 'iboard'}
          >
            iBoard 投稿{scope === 'mine' ? '（自分のみ）' : ''}
          </button>
          <button
            className={`ibp-tab ${tab === 'album' ? 'active' : ''}`}
            onClick={() => setTab('album')}
            aria-pressed={tab === 'album'}
          >
            Album / Storage
          </button>
          {tab === 'album' && (
            <label className="upload-btn" style={{ marginLeft: 8 }}>
              {uploading ? 'アップロード中…' : '画像をアップロード'}
              <input type="file" accept="image/*" onChange={handleUpload} disabled={uploading} hidden />
            </label>
          )}
        </div>

        <div className="ibp-size">
          <label>サムネ</label>
          <input
            type="range"
            min={50}
            max={160}
            step={2}
            value={thumb}
            onChange={(e) => setThumb(Number(e.target.value))}
            aria-label="サムネサイズ"
          />
          <span>{thumb}px</span>
        </div>
      </div>

      {loading && <div className="ibp-status">読み込み中…</div>}
      {errorMsg && <div className="ibp-error">⚠ {errorMsg}</div>}

      {!loading && !errorMsg && (
        <div className="ibp-grid-wrap">
          {tab === 'iboard' ? (
            <div className="ibp-grid">
              {posts.map((p) => {
                const urls = Array.isArray(p.media_urls)
                  ? p.media_urls.map((u: any) => (typeof u === 'string' ? u : u?.url || '')).filter(Boolean)
                  : [];
                const src = urls[0] || '';
                const isSel = current === p.post_id;
                return (
                  <button
                    key={p.post_id}
                    type="button"
                    className={`ibp-card ${isSel ? 'is-selected' : ''}`}
                    onClick={() => selectIboard(p)}
                    title={p.post_id}
                    aria-label="iBoard画像を選択"
                  >
                    <img src={src} alt="" className="ibp-thumb" />
                    {isSel && <div className="ibp-check">✓</div>}
                  </button>
                );
              })}
              {posts.length === 0 && (
                <div className="ibp-empty">
                  {scope === 'mine'
                    ? '自分の iBoard 画像投稿が見つかりません。'
                    : '画像付きの iBoard 投稿が見つかりません。'
                  }
                  <br />
                  「Album / Storage」タブから選ぶか、右上のアップロードをご利用ください。
                </div>
              )}
            </div>
          ) : (
            <div className="ibp-grid">
              {album.map((it) => {
                const isSel = current === it.id;
                return (
                  <button
                    key={it.id}
                    type="button"
                    className={`ibp-card ${isSel ? 'is-selected' : ''}`}
                    onClick={() => selectAlbum(it)}
                    title={it.path}
                    aria-label="アルバム画像を選択"
                  >
                    <img src={it.url} alt="" className="ibp-thumb" />
                    {isSel && <div className="ibp-check">✓</div>}
                  </button>
                );
              })}
              {album.length === 0 && (
                <div className="ibp-empty">
                  アルバムに画像がありません。右上からアップロードできます。
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
