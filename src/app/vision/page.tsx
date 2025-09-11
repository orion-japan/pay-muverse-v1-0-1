'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import VisionModal from '@/components/VisionModal';
import { supabase } from '@/lib/supabase';
import type { Vision, Phase, Stage } from '@/types/vision';
import './vision.css';

import DailyCheckPanel from '@/components/DailyCheckPanel';
import '@/components/DailyCheckPanel.css';
import StageChecklistInline from '@/components/StageChecklistInline';

/* ====== album:// 解決用（private-posts の署名URL） ====== */
const ALBUM_BUCKET = 'private-posts';

function useThumbUrl(raw?: string | null) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    (async () => {
      if (!raw) { if (!canceled) setUrl(null); return; }

      if (raw.startsWith('album://')) {
        let path = raw.replace(/^album:\/\//, '').replace(/^\/+/, '');
        // うっかり 'private-posts/' が入っても剥がす
        path = path.replace(new RegExp(`^(?:${ALBUM_BUCKET}/)+`), '');
        const { data, error } = await supabase
          .storage
          .from(ALBUM_BUCKET)
          .createSignedUrl(path, 60 * 60); // 1h
        if (canceled) return;
        setUrl(error ? null : (data?.signedUrl ?? null));
      } else {
        if (!canceled) setUrl(raw); // 直URL（public-posts 等）はそのまま
      }
    })();
    return () => { canceled = true; };
  }, [raw]);

  return url;
}

// ループ内でも使える薄い子コンポーネント
function VisionThumb({ raw, className = 'vision-thumb' }:{
  raw?: string | null;
  className?: string;
}) {
  const resolved = useThumbUrl(raw);
  if (!resolved) return <div className={`${className} ${className}--ph`}>No Image</div>;
  return <img src={resolved} alt="" className={className} />;
}

/* ========= ログ ========= */
const L = {
  ord: (...a: any[]) => console.log('[Order]', ...a),
  api: (...a: any[]) => console.log('[API]', ...a),
  dnd: (...a: any[]) => console.log('[DnD]', ...a),
  sel: (...a: any[]) => console.log('[Select]', ...a),
};

const STAGES: { key: Stage; label: string; icon: string }[] = [
  { key: 'S', label: '種',     icon: '🌱' },
  { key: 'F', label: '広げる', icon: '🌊' },
  { key: 'R', label: '洞察',   icon: '🪞' },
  { key: 'C', label: '実践',   icon: '🔧' },
  { key: 'I', label: '結果',   icon: '🌌' },
];

type VisionWithTS = Vision & {
  created_at?: string | null;
  updated_at?: string | null;
  archived_at?: string | null;
  moved_to_history_at?: string | null;
  sort_index?: number | null;
  iboard_thumb?: string | null;
  iboard_post_id?: string | null;
};

/** localStorage keys */
const LS_SELECTED = 'vision.selected';
const LS_ORDER_PREFIX = 'vision.order.'; // フェーズ単位で保存

type StageOrder = Record<Stage, string[]>;
const emptyOrder = (): StageOrder => ({ S: [], F: [], R: [], C: [], I: [] });
const orderKey = (phase: Phase) => `${LS_ORDER_PREFIX}${phase}`;

/* 並びの保存 */
function saveOrder(phase: Phase, list: VisionWithTS[]) {
  const o = emptyOrder();
  for (const v of list) if (v.vision_id) o[v.stage].push(String(v.vision_id));
  try {
    localStorage.setItem(orderKey(phase), JSON.stringify(o));
    L.ord('save', phase, o);
  } catch (e) {
    L.ord('save error', e as any);
  }
}

/* 並びの読み出し */
function loadOrder(phase: Phase): StageOrder {
  try {
    const raw = localStorage.getItem(orderKey(phase));
    const o = raw ? (JSON.parse(raw) as StageOrder) : emptyOrder();
    L.ord('load', phase, o);
    return o;
  } catch {
    return emptyOrder();
  }
}

/* 取得済みrowsに保存順をステージ毎に適用して合成 */
function applyOrderByStage(phase: Phase, rows: VisionWithTS[]) {
  const ord = loadOrder(phase);
  const ts = (v: VisionWithTS) => Date.parse(v.updated_at ?? v.created_at ?? '') || 0;
  const pos = new Map<string, number>();
  (Object.keys(ord) as Stage[]).forEach(st => ord[st].forEach((id, i) => pos.set(`${st}:${id}`, i)));

  function sortedFor(stage: Stage) {
    const arr = rows.filter(r => r.stage === stage);
    return arr.sort((a, b) => {
      const pa = pos.get(`${stage}:${String(a.vision_id)}`) ?? Number.MAX_SAFE_INTEGER;
      const pb = pos.get(`${stage}:${String(b.vision_id)}`) ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return ts(b) - ts(a); // セーブに無いものは更新新しい順
    });
  }

  const next = ([] as VisionWithTS[])
    .concat(sortedFor('S'))
    .concat(sortedFor('F'))
    .concat(sortedFor('R'))
    .concat(sortedFor('C'))
    .concat(sortedFor('I'));

  L.ord('apply result (head)', next.slice(0, 5).map(v => ({ id: v.vision_id, st: v.stage })));
  return next;
}

export default function VisionPage() {
  // フェーズは API と一致するキーで
  const [phase, setPhase] = useState<Phase>('initial');
  const [visions, setVisions] = useState<VisionWithTS[]>([]);
  const [openStage, setOpenStage] = useState<Stage | null>(null);
  const [editing, setEditing] = useState<VisionWithTS | null>(null);

  const [userCode, setUserCode] = useState<string>('');
  const [selectedVisionId, setSelectedVisionId] = useState<string | null>(null);
  const selectedVision = useMemo(
    () => visions.find(v => v.vision_id === selectedVisionId) || null,
    [visions, selectedVisionId]
  );

  /** 初回だけ自動選択（以降はユーザー選択を上書きしない） */
  const autoInitDoneRef = useRef(false);
  /** 競合する fetch 応答の破棄用タグ */
  const loadSeqRef = useRef(0);

  const [dragging, setDragging] = useState(false);

  /** ←★ 追加: 押した直後にカードを隠すためのセット */
  const [pendingHide, setPendingHide] = useState<Set<string>>(new Set());

  /** ←★ 追加: アクティブ判定（履歴/アーカイブ済みを除外） */
  const isActiveVision = (v: VisionWithTS) =>
    !v.archived_at && !v.moved_to_history_at;

  /** 既存選択の復元 */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_SELECTED);
      if (saved) {
        setSelectedVisionId(saved);
        autoInitDoneRef.current = true;
        L.sel('restore', saved);
      }
    } catch {}
  }, []);

  /** 一覧取得（未ログインなら匿名サインイン） */
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    (async () => {
      const { getAuth, onAuthStateChanged, signInAnonymously } = await import('firebase/auth');
      const auth = getAuth();

      const load = async (user: any) => {
        const seq = ++loadSeqRef.current;
        try {
          if (!user) {
            await signInAnonymously(auth);
            user = auth.currentUser;
          }
          if (!user) {
            if (seq !== loadSeqRef.current) return;
            setVisions([]);
            setUserCode('');
            return;
          }

          setUserCode(user.uid);
          const token = await user.getIdToken();
          L.api('GET /api/visions', { phase });

          const res = await fetch(`/api/visions?phase=${phase}`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
          });

          // 配列 / {ok, data} 両対応
          let payload: any = null;
          try { payload = await res.json(); } catch { payload = null; }

          if (!res.ok || (payload && typeof payload === 'object' && 'ok' in payload && !payload.ok)) {
            if (seq !== loadSeqRef.current) return;
            setVisions([]);
            L.api('GET failed', res.status, payload?.error);
            return;
          }

          const rows: VisionWithTS[] = Array.isArray(payload) ? payload : (payload?.data ?? []);
          if (seq !== loadSeqRef.current) return;

          const normalized = rows.map(v => ({ ...v, vision_id: String(v.vision_id) }));
          const withThumbs = await enrichThumbs(normalized);
          if (seq !== loadSeqRef.current) return;

          const applied = applyOrderByStage(phase, withThumbs);
          setVisions(applied);

          // 初回だけ自動選択
          if (!autoInitDoneRef.current) {
            autoInitDoneRef.current = true;
            const stored = (() => { try { return localStorage.getItem(LS_SELECTED); } catch { return null; } })();
            if (stored && applied.some(v => v.vision_id === stored)) {
              setSelectedVisionId(stored);
            } else {
              const latest = [...applied].sort((a, b) => {
                const ta = Date.parse(a.updated_at ?? a.created_at ?? '') || 0;
                const tb = Date.parse(b.updated_at ?? b.created_at ?? '') || 0;
                return tb - ta;
              })[0]?.vision_id ?? null;
              setSelectedVisionId(latest);
              try { if (latest) localStorage.setItem(LS_SELECTED, latest); } catch {}
            }
          }
        } catch (e) {
          if (seq !== loadSeqRef.current) return;
          setVisions([]);
          L.api('GET exception', e);
        }
      };

      // サインイン状態変化で再読込 & 初回読込
      unsubscribe = onAuthStateChanged(auth, (u) => { void load(u); });
      void load(auth.currentUser);
    })();

    // クリーンアップ
    return () => { if (unsubscribe) unsubscribe(); };
  }, [phase]);

  /** フェーズ切替時は選択をクリア（再度“初回”扱い） */
  useEffect(() => {
    setSelectedVisionId(null);
    autoInitDoneRef.current = false;
    try { localStorage.removeItem(LS_SELECTED); } catch {}
  }, [phase]);

  /** iBoard サムネ取得（既存の album:// は尊重し、無い時だけ iBoard から補完） */
  async function enrichThumbs(rows: VisionWithTS[]): Promise<VisionWithTS[]> {
    const ids = rows.map(r => r.iboard_post_id).filter(Boolean) as string[];
    if (ids.length === 0) return rows;

    const { data, error } = await supabase
      .from('posts')
      .select('post_id, media_urls')
      .in('post_id', ids);

    if (error || !data) return rows;

    const map = new Map<string, string>();
    for (const p of data) {
      const url = Array.isArray(p.media_urls) ? p.media_urls[0] : null;
      if (url) map.set(p.post_id, url);
    }

    // ★ 既存の iboard_thumb（album://... など）があればそれを優先
    return rows.map(r => {
      const keepAlbum = (typeof r.iboard_thumb === 'string' && r.iboard_thumb) ? r.iboard_thumb : null;
      const fromIboard = r.iboard_post_id ? (map.get(r.iboard_post_id) ?? null) : null;
      return { ...r, iboard_thumb: keepAlbum ?? fromIboard };
    });
  }

  /* ===== D&D ===== */
  const onDragStart = () => { setDragging(true); L.dnd('start'); };

  function reorder<T>(list: T[], startIndex: number, endIndex: number): T[] {
    const result = Array.from(list);
    const [removed] = result.splice(startIndex, 1);
    result.splice(endIndex, 0, removed);
    return result;
  }

  const onDragEnd = async (result: DropResult) => {
    setDragging(false);
    if (!result.destination) { L.dnd('end: no destination'); return; }
    const { source, destination, draggableId } = result;
    L.dnd('end', { source, destination, draggableId });

    const fromSt = source.droppableId as Stage;
    const toSt   = destination.droppableId as Stage;

    // === 同一カラム内の並べ替え（バッチで sort_index 保存） ===
    if (fromSt === toSt) {
      // 次状態を先に計算
      const same = visions.filter(v => v.stage === fromSt);
      const reordered = reorder(same, source.index, destination.index)
        .map((v, i) => ({ ...v, sort_index: i }));
      const others = visions.filter(v => v.stage !== fromSt);
      const next = [...others, ...reordered];

      setVisions(next);
      saveOrder(phase, next);

      // サーバー保存（対象列のみをバッチPUT）
      try {
        const { getAuth, signInAnonymously } = await import('firebase/auth');
        const auth = getAuth();
        if (!auth.currentUser) await signInAnonymously(auth);
        const token = await auth.currentUser!.getIdToken();

        const order = reordered.map(v => ({ vision_id: v.vision_id, sort_index: v.sort_index ?? 0 }));
        await fetch('/api/visions', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ order }),
        });
      } catch (e) { L.api('PUT reorder error', e); }
      return;
    }

    // === 別カラムへ移動（from/to 両列をバッチPUT） ===
    const movedId = String(draggableId);
    const moved = visions.find(v => String(v.vision_id) === movedId);
    if (!moved) return;

    // to列の一覧（移動先に差し込み）
    const toList = visions
      .filter(v => v.stage === toSt && String(v.vision_id) !== movedId);
    const movedUpdated = { ...moved, stage: toSt };
    toList.splice(destination.index, 0, movedUpdated);

    // from列の一覧（移動元から除外）
    const fromList = visions
      .filter(v => v.stage === fromSt && String(v.vision_id) !== movedId);

    // sort_index 振り直し
    const toWithIndex   = toList.map((v, i) => ({ ...v, sort_index: i }));
    const fromWithIndex = fromList.map((v, i) => ({ ...v, sort_index: i }));

    const others = visions.filter(v => v.stage !== toSt && v.stage !== fromSt);
    const next = [...others, ...fromWithIndex, ...toWithIndex];

    setVisions(next);
    saveOrder(phase, next);

    // サーバー保存（① stage を単体PUT → ② 並びをまとめてPUT）
    try {
      const { getAuth, signInAnonymously } = await import('firebase/auth');
      const auth = getAuth();
      if (!auth.currentUser) await signInAnonymously(auth);
      const token = await auth.currentUser!.getIdToken();
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

      // ① 移動したカードの stage を保存
      await fetch('/api/visions', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          vision_id: movedId,
          stage: toSt,
        }),
      });

      // ② from/to 両列の sort_index をまとめて保存
      const order = [
        ...fromWithIndex.map(v => ({ vision_id: v.vision_id, sort_index: v.sort_index ?? 0 })),
        ...toWithIndex  .map(v => ({ vision_id: v.vision_id, sort_index: v.sort_index ?? 0 })),
      ];
      await fetch('/api/visions', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ order }),
      });
    } catch (e) {
      L.api('PUT move error', e);
      // 必要なら整合回復のために再取得を促す:
      // setPhase(p => p);
    }
  };

/* 保存後の反映（新規/更新）— 並びルールを適用して即時反映 */
const upsertLocal = (saved: VisionWithTS) => {
  const normalized: VisionWithTS = { ...saved, vision_id: String(saved.vision_id) };

  setVisions(prev => {
    const i = prev.findIndex(x => String(x.vision_id) === normalized.vision_id);
    const next = [...prev];

    if (i >= 0) {
      // 既存を置き換え（ステージ変更もここで反映）
      next[i] = normalized;
    } else {
      // 新規は一旦末尾に追加
      next.push(normalized);
    }

    // ★ 既存の保存順（localStorage）を尊重して並び直す
    const applied = applyOrderByStage(phase, next);

    // ★ 並びも保存（次回リロード時に同じ順序で出せるように）
    saveOrder(phase, applied);

    return applied;
  });

  // 選択を更新＆永続化
  try { localStorage.setItem(LS_SELECTED, String(normalized.vision_id)); } catch {}
  setSelectedVisionId(String(normalized.vision_id));
};


  /* 選択の永続化 */
  function persistSelected(id: string | null) {
    try { id ? localStorage.setItem(LS_SELECTED, id) : localStorage.removeItem(LS_SELECTED); } catch {}
  }

  /** ←★ 追加: 履歴移動後の即時反映（楽観的隠し＋確定除去） */
  function handleArchived(vid: string) {
    setPendingHide(prev => new Set(prev).add(String(vid)));
    setVisions(prev => prev.filter(v => String(v.vision_id) !== String(vid)));
    setSelectedVisionId(null);
  }

  return (
    <div className="vision-shell">
      {/* DnD保険: CSSの衝突を最小限で抑止（必要な時だけ有効に） */}
      <style>{`
        /* PDF推奨の保険: 縦スクロールコンテナのネストを避ける */ 
        .vision-board{overflow-y:visible!important}
        .vision-column{overflow:visible!important}
        .vision-col-body{overflow-y:visible!important;min-height:16px}
        /* transform はライブラリに任せる（直接指定しない） */
      `}</style>

      {/* === フェーズタブ ＋ 新規＋履歴 === */}
      <div className="vision-topbar">
        <div className="vision-tabs">
          <button
            className={phase === 'initial' ? 'is-active' : ''}
            onClick={() => setPhase('initial')}
          >
            初期
          </button>

          <button
            className={phase === 'mid' ? 'is-active' : ''}
            onClick={() => setPhase('mid')}
          >
            中期
          </button>

          <button
            className={phase === 'final' ? 'is-active' : ''}
            onClick={() => setPhase('final')}
          >
            後期
          </button>
        </div>

        <div className="vision-actions">
          <a className="vision-history-link" href="/vision/history">履歴を見る</a>
          <button className="vision-new-global" onClick={() => setOpenStage('S')}>
            ＋ 新規
          </button>
        </div>
      </div>

      {/* カンバン */}
      <DragDropContext onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="vision-board">
          {STAGES.map(stage => (
            <Droppable droppableId={stage.key} key={stage.key}>
              {(dropProvided) => (
                <div className="vision-column">
                  <div className="vision-col-header">{stage.icon} {stage.label}</div>
                  <div
                    ref={dropProvided.innerRef}
                    {...dropProvided.droppableProps}
                    className="vision-col-body"
                  >
                    {visions
                      .filter(v =>
                        v.stage === stage.key &&
                        isActiveVision(v) &&                        // ←★ 履歴/アーカイブ除外
                        !pendingHide.has(String(v.vision_id))       // ←★ 押した瞬間に非表示
                      )
                      .map((vision, index) => (
                        <Draggable
                          key={String(vision.vision_id)}
                          draggableId={String(vision.vision_id)}
                          index={index}
                        >
                          {(dragProvided, snapshot) => (
                            <div
                              ref={dragProvided.innerRef}
                              {...dragProvided.draggableProps}
                              {...dragProvided.dragHandleProps}
                              className={`vision-card ${snapshot.isDragging ? 'is-dragging' : ''} ${selectedVisionId === vision.vision_id ? 'is-selected' : ''}`}
                              onClick={() => {
                                persistSelected(String(vision.vision_id));
                                setSelectedVisionId(String(vision.vision_id));
                                L.sel('card', vision.vision_id);
                              }}
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                setEditing(vision); // ダブルクリックで編集モーダル
                              }}
                            >
                              {/* サムネ（album:// or 直URL 両対応） */}
                              {(() => {
                                const rawThumb =
                                  (typeof vision.iboard_thumb === 'string' && vision.iboard_thumb) ||
                                  (vision as any).thumbnailUrl || (vision as any).thumbnail_url || null;
                                return <VisionThumb raw={rawThumb} className="vision-thumb" />;
                              })()}

                              {/* 右上の編集ボタン（任意） */}
                              <button
                                className="vision-edit-btn"
                                onClick={(e) => { e.stopPropagation(); setEditing(vision); }}
                                aria-label="編集"
                              >
                                ✎
                              </button>

                              <div className="vision-title">{vision.title}</div>

                              {/* 橋渡しチェック（クリック伝播を止める） */}
                              <div className="vision-card-bridge" onClick={(e) => e.stopPropagation()}>
                                <StageChecklistInline
                                  visionId={String(vision.vision_id)}
                                  from={vision.stage}
                                  showActions={false}
                                  visionStatus={vision.status as any}
                                />
                              </div>
                            </div>
                          )}
                        </Draggable>
                      ))}
                    {dropProvided.placeholder}
                  </div>
                </div>
              )}
            </Droppable>
          ))}
        </div>
      </DragDropContext>

      {/* 実践チェック */}
      <div className="daily-check-frame">
        {userCode && selectedVision ? (
          <DailyCheckPanel
            key={String(selectedVision.vision_id)}
            userCode={userCode}
            selectedVisionId={String(selectedVision.vision_id)}
            selectedStage={selectedVision.stage}
            selectedVisionTitle={selectedVision.title}
            // ★ 履歴へ移動完了時に即非表示
            onArchived={(vid: string) => handleArchived(vid)}
          />
        ) : (
          <div className="daily-check-empty">
            ビジョンカードを選択すると、ここに「1日の実践チェック」が表示されます。
          </div>
        )}
      </div>

      {/* 新規モーダル */}
      {openStage && (
        <VisionModal
          isOpen={true}
          defaultPhase={phase}
          defaultStage={'S'}
          userCode={userCode}
          onClose={() => setOpenStage(null)}
          onSaved={(v) => { upsertLocal(v as VisionWithTS); setOpenStage(null); }}
        />
      )}

      {/* 編集モーダル */}
      {editing && (
        <VisionModal
          isOpen={true}
          defaultPhase={editing.phase}
          defaultStage={editing.stage}
          userCode={userCode}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(v) => { upsertLocal(v as VisionWithTS); setEditing(null); }}
        />
      )}
    </div>
  );
}
