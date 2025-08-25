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

const STAGES: { key: Stage; label: string; icon: string }[] = [
  { key: 'S', label: '種',     icon: '🌱' },
  { key: 'F', label: '広げる', icon: '🌊' },
  { key: 'R', label: '洞察',   icon: '🪞' },
  { key: 'C', label: '実践',   icon: '🔧' },
  { key: 'I', label: '結果',   icon: '🌌' },
];

type VisionWithTS = Vision & { created_at?: string | null; updated_at?: string | null };

/** localStorage keys */
const LS_SELECTED = 'vision.selected';

export default function VisionPage() {
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

  /** 初回だけ自動選択する（以後はユーザー操作以外で上書きしない） */
  const autoInitDoneRef = useRef(false);
  /** 競合する fetch 応答の破棄用タグ */
  const loadSeqRef = useRef(0);

  const [dragging, setDragging] = useState(false);

  /** 既存選択の復元（HMR/再読み込み対策） */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_SELECTED);
      if (saved) {
        setSelectedVisionId(saved);
        autoInitDoneRef.current = true; // 既に選択がある → 自動選択不要
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

          const res = await fetch(`/api/visions?phase=${phase}`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
          });
          if (!res.ok) {
            if (seq !== loadSeqRef.current) return;
            setVisions([]);
            return;
          }

          const rows = await res.json();
          if (seq !== loadSeqRef.current) return;

          const visionsArr = (Array.isArray(rows) ? rows : []) as VisionWithTS[];
          const withThumbs = await enrichThumbs(visionsArr);
          if (seq !== loadSeqRef.current) return;

          setVisions(withThumbs);

          // --- 自動選択は初回だけ ---
          if (!autoInitDoneRef.current) {
            autoInitDoneRef.current = true;

            const stored = getStoredSelected();
            if (stored && withThumbs.some(v => v.vision_id === stored)) {
              persistSelected(stored);
              setSelectedVisionId(stored);
              return;
            }

            const sorted = [...withThumbs].sort((a, b) => {
              const ta = Date.parse(a.updated_at ?? a.created_at ?? '') || 0;
              const tb = Date.parse(b.updated_at ?? b.created_at ?? '') || 0;
              return tb - ta;
            });
            const next = sorted[0]?.vision_id ?? null;
            persistSelected(next);
            setSelectedVisionId(next);
          }
        } catch {
          if (seq !== loadSeqRef.current) return;
          setVisions([]);
        }
      };

      unsubscribe = onAuthStateChanged(auth, load);
    })();

    return () => { if (unsubscribe) unsubscribe(); };
  }, [phase]);

  /** フェーズ切替時は選択をクリア（再度“初回”とみなす） */
  useEffect(() => {
    setSelectedVisionId(null);
    autoInitDoneRef.current = false;
    try { localStorage.removeItem(LS_SELECTED); } catch {}
  }, [phase]);

  /** iBoard サムネ取得 */
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

    return rows.map(r => ({
      ...r,
      iboard_thumb: r.iboard_post_id ? map.get(r.iboard_post_id) ?? null : null,
    }));
  }

  /* ===== D&D ===== */
  const onDragStart = () => setDragging(true);

  function reorder<T>(list: T[], startIndex: number, endIndex: number): T[] {
    const result = Array.from(list);
    const [removed] = result.splice(startIndex, 1);
    result.splice(endIndex, 0, removed);
    return result;
  }

  const onDragEnd = async (result: DropResult) => {
    setDragging(false);
    if (!result.destination) return;
    const { source, destination, draggableId } = result;

    // 同一カラム内の並べ替え
    if (source.droppableId === destination.droppableId) {
      setVisions(prev => {
        const st = source.droppableId as Stage;
        const same = prev.filter(v => v.stage === st);
        const others = prev.filter(v => v.stage !== st);
        const reordered = reorder(same, source.index, destination.index);
        return [...others, ...reordered];
      });
      try {
        const { getAuth, signInAnonymously } = await import('firebase/auth');
        const auth = getAuth();
        if (!auth.currentUser) await signInAnonymously(auth);
        const token = await auth.currentUser!.getIdToken();
        await fetch('/api/visions', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ vision_id: draggableId, stage: destination.droppableId, order_index: destination.index }),
        });
      } catch (e) { console.error('PUT reorder error:', e); }
      return;
    }

    // 別カラムへ移動
    setVisions(prev =>
      prev.map(v => (v.vision_id === draggableId ? { ...v, stage: destination.droppableId as Stage } : v))
    );
    try {
      const { getAuth, signInAnonymously } = await import('firebase/auth');
      const auth = getAuth();
      if (!auth.currentUser) await signInAnonymously(auth);
      const token = await auth.currentUser!.getIdToken();
      await fetch('/api/visions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ vision_id: draggableId, stage: destination.droppableId }),
      });
    } catch (e) { console.error('PUT visions error:', e); }
  };

  /* 保存後の反映（新規/更新） */
  const upsertLocal = (saved: VisionWithTS) => {
    const normalized = openStage ? { ...saved, stage: 'S' as Stage } : saved;
    setVisions(prev => {
      const i = prev.findIndex(x => x.vision_id === normalized.vision_id);
      const next = [...prev];
      if (i >= 0) next[i] = normalized;
      else next.push(normalized);
      return next;
    });
    if (normalized.vision_id) {
      persistSelected(normalized.vision_id);
      setSelectedVisionId(normalized.vision_id);
    }
  };

  /* 永続化ユーティリティ */
  function persistSelected(id: string | null) {
    try {
      if (id) localStorage.setItem(LS_SELECTED, id);
      else localStorage.removeItem(LS_SELECTED);
    } catch {}
  }
  function getStoredSelected(): string | null {
    try { return localStorage.getItem(LS_SELECTED); } catch { return null; }
  }

  return (
    <div className="vision-shell">
      {/* 右上：新規（必ず S から） */}
      <div className="vision-topbar">
        <button className="vision-new-global" onClick={() => setOpenStage('S')}>＋ 新規</button>
      </div>

      {/* タブ */}
      <div className="vision-tabs">
        <button className={phase === 'initial' ? 'is-active' : ''} onClick={() => setPhase('initial')}>初期</button>
        <button className={phase === 'mid' ? 'is-active' : ''} onClick={() => setPhase('mid')}>中期</button>
        <button className={phase === 'final' ? 'is-active' : ''} onClick={() => setPhase('final')}>後期</button>
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
                      .filter(v => v.stage === stage.key)
                      .map((vision, index) => (
                        <Draggable
                          key={vision.vision_id}
                          draggableId={vision.vision_id}
                          index={index}
                        >
                          {(dragProvided, snapshot) => (
                            <div
                              ref={dragProvided.innerRef}
                              {...dragProvided.draggableProps}
                              {...dragProvided.dragHandleProps}
                              className={`vision-card ${snapshot.isDragging ? 'is-dragging' : ''} ${selectedVisionId === vision.vision_id ? 'is-selected' : ''}`}
                              onClick={() => {
                                persistSelected(vision.vision_id);
                                setSelectedVisionId(vision.vision_id);
                              }}
                            >
                              {/* タイトルやサムネ（必要に応じて） */}
                              {vision.iboard_thumb && (
                                <img src={vision.iboard_thumb as any} alt="" className="vision-thumb" />
                              )}
                              <div className="vision-title">{vision.title}</div>

                              {/* 下段：橋渡しチェック（クリック伝播を止める） */}
                              <div className="vision-card-bridge" onClick={(e) => e.stopPropagation()}>
                                <StageChecklistInline
                                  visionId={vision.vision_id}
                                  from={vision.stage}
                                  showActions={false}
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
            key={selectedVision.vision_id}
            userCode={userCode}
            selectedVisionId={selectedVision.vision_id!}
            selectedStage={selectedVision.stage}
            selectedVisionTitle={selectedVision.title}
          />
        ) : (
          <div className="daily-check-empty">
            ビジョンカードを選択すると、ここに「1日の実践チェック」が表示されます。
          </div>
        )}
      </div>

      {/* 新規作成モーダル（S固定） */}
      {openStage && (
        <VisionModal
          isOpen={true}
          defaultPhase={phase}
          defaultStage={'S'}
          userCode={''}
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
          userCode={''}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(v) => { upsertLocal(v as VisionWithTS); setEditing(null); }}
        />
      )}
    </div>
  );
}
