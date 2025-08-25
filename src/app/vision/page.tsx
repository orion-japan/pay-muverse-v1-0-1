'use client';

import { useEffect, useState } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import VisionModal from '@/components/VisionModal';
import { supabase } from '@/lib/supabase';
import type { Vision, Phase, Stage } from '@/types/vision';
import './vision.css';

import StageChecklistInline from '@/components/StageChecklistInline';
import DailyCheckPanel from '@/components/DailyCheckPanel';
import '@/components/DailyCheckPanel.css';

/* 列（ステージ）定義 */
const STAGES: { key: Stage; label: string; icon: string }[] = [
  { key: 'S', label: '種',     icon: '🌱' },
  { key: 'F', label: '広げる', icon: '🌊' },
  { key: 'R', label: '洞察',   icon: '🪞' },
  { key: 'C', label: '実践',   icon: '🔧' },
  { key: 'I', label: '結果',   icon: '🌌' },
];

type VisionWithTS = Vision & { created_at?: string | null; updated_at?: string | null };

export default function VisionPage() {
  const [phase, setPhase] = useState<Phase>('initial');
  const [visions, setVisions] = useState<VisionWithTS[]>([]);
  const [openStage, setOpenStage] = useState<Stage | null>(null); // 新規モーダルのトリガ
  const [editing, setEditing] = useState<VisionWithTS | null>(null);

  const [userCode, setUserCode] = useState<string>('');
  const [selectedVisionId, setSelectedVisionId] = useState<string | null>(null);

  const [dragging, setDragging] = useState(false);

  function reorder<T>(list: T[], startIndex: number, endIndex: number): T[] {
    const result = Array.from(list);
    const [removed] = result.splice(startIndex, 1);
    result.splice(endIndex, 0, removed);
    return result;
  }

  /* ===== 一覧取得 ===== */
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    (async () => {
      const { getAuth, onAuthStateChanged, signInAnonymously } = await import('firebase/auth');
      const auth = getAuth();

      const load = async (user: any) => {
        try {
          if (!user) {
            await signInAnonymously(auth);
            user = auth.currentUser;
          }
          if (!user) {
            setVisions([]);
            setUserCode('');
            return;
          }

          setUserCode(user.uid);
          const token = await user.getIdToken();

          const res = await fetch(`/api/visions?phase=${phase}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) {
            console.error('GET /api/visions failed:', res.status, await res.text());
            setVisions([]);
            return;
          }

          const rows = await res.json();
          const arr = (Array.isArray(rows) ? rows : []) as VisionWithTS[];
          const withThumbs = await enrichThumbs(arr);
          setVisions(withThumbs);
          chooseHottest(withThumbs);
        } catch (err) {
          console.error('GET visions error:', err);
          setVisions([]);
        }
      };

      unsubscribe = onAuthStateChanged(auth, load);
    })();

    return () => { if (unsubscribe) unsubscribe(); };
  }, [phase]);

  useEffect(() => { setSelectedVisionId(null); }, [phase]);

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

  function chooseHottest(vs: VisionWithTS[]) {
    if (!vs || vs.length === 0) return;
    const sorted = [...vs].sort((a, b) => {
      const ta = Date.parse(a.updated_at ?? a.created_at ?? '') || 0;
      const tb = Date.parse(b.updated_at ?? b.created_at ?? '') || 0;
      return tb - ta;
    });
    const hottest = sorted[0];
    if (hottest?.vision_id) setSelectedVisionId(hottest.vision_id);
  }

  /* ===== D&D ===== */
  const onDragStart = () => setDragging(true);

  const onDragEnd = async (result: DropResult) => {
    setDragging(false);
    if (!result.destination) return;
    const { source, destination, draggableId } = result;

    // 同列の並べ替え
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

    // 列をまたいで移動
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

      // 移動先ステージの criteria が無ければ自動作成
      const toStage = destination.droppableId as Stage;
      const getRes = await fetch(`/api/vision-criteria?vision_id=${encodeURIComponent(draggableId)}&from=${toStage}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      let needCreate = false;
      if (getRes.ok) {
        const data = await getRes.json().catch(() => null);
        needCreate = data == null;
      }
      if (needCreate) {
        await fetch('/api/vision-criteria', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ vision_id: draggableId, from: toStage, required_days: 3, checklist: [] }),
        });
      }
    } catch (e) { console.error('PUT visions / ensure criteria error:', e); }
  };

  /* 保存後の反映 */
  const upsertLocal = (saved: VisionWithTS) => {
    const normalized = openStage ? { ...saved, stage: 'S' as Stage } : saved;
    setVisions(prev => {
      const i = prev.findIndex(x => x.vision_id === normalized.vision_id);
      const next = [...prev];
      if (i >= 0) next[i] = normalized;
      else next.push(normalized);
      return next;
    });
    if (normalized.vision_id) setSelectedVisionId(normalized.vision_id);
  };

  return (
    <div className="vision-shell">
      {/* 右上：新規（常に S で作る） */}
      <div className="vision-topbar">
        <button className="vision-new-global" onClick={() => setOpenStage('S')}>＋ 新規</button>
      </div>

      {/* 上部タブ */}
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
              {provided => (
                <div className="vision-column" ref={provided.innerRef} {...provided.droppableProps}>
                  <div className="vision-col-header">{stage.icon} {stage.label}</div>

                  <div className="vision-col-body">
                    {(Array.isArray(visions) ? visions : [])
                      .filter(v => v.stage === stage.key)
                      .map((v, idx) => (
                        <Draggable draggableId={v.vision_id!} index={idx} key={v.vision_id}>
                          {(prov, snapshot) => (
                            <div
                              className={`vision-card ${snapshot.isDragging ? 'is-dragging' : ''} ${selectedVisionId === v.vision_id ? 'is-selected' : ''}`}
                              ref={prov.innerRef}
                              {...prov.draggableProps}
                            >
                              <button
                                className="vision-drag-handle"
                                {...prov.dragHandleProps}
                                onClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                                aria-label="ドラッグして並び替え"
                              >⠿</button>

                              {/* クリック時：先に選択IDを更新 → その後モーダル */}
                              <div
                                className="vision-card-click"
                                {...prov.dragHandleProps}
                                onClick={() => {
                                  setSelectedVisionId(v.vision_id!);
                                  if (!dragging) setEditing(v);
                                }}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    setSelectedVisionId(v.vision_id!);
                                    if (!dragging) setEditing(v);
                                  }
                                }}
                              >
                                {v.iboard_thumb && <img src={v.iboard_thumb} alt="" className="vision-thumb" />}
                                <div className="vision-title">{v.title}</div>
                              </div>

                              <div
                                className="vision-card-bridge"
                                onClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                              >
                                <StageChecklistInline visionId={v.vision_id!} from={v.stage} showActions={false} />
                              </div>
                            </div>
                          )}
                        </Draggable>
                      ))}
                    {provided.placeholder}
                  </div>

                  {/* 列の「＋カード」は無し */}
                </div>
              )}
            </Droppable>
          ))}
        </div>
      </DragDropContext>

      {/* 1日の実践チェック（選択Visionごとに再マウントさせる） */}
      <div className="daily-check-frame">
        {userCode && selectedVisionId ? (
          <DailyCheckPanel
            key={selectedVisionId}     // ← 切替で必ず再マウント
            userCode={userCode}
            selectedVisionId={selectedVisionId}
          />
        ) : (
          <div className="daily-check-empty">
            ビジョンカードを選択すると、ここに「1日の実践チェック」が表示されます。
          </div>
        )}
      </div>

      {/* 新規作成モーダル（必ず S で作る） */}
      {openStage && (
        <VisionModal
          isOpen={true}
          defaultPhase={phase}
          defaultStage={'S'}
          userCode={''}
          onClose={() => setOpenStage(null)}
          onSaved={(v) => { upsertLocal({ ...(v as VisionWithTS), stage: 'S' }); setOpenStage(null); }}
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
