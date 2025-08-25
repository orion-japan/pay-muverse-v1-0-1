'use client';

import { useEffect, useState } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import VisionModal from '@/components/VisionModal';
import { supabase } from '@/lib/supabase';
import type { Vision, Phase, Stage } from '@/types/vision';
import './vision.css';

// 追加：インラインの橋渡しチェック
import StageChecklistInline from '@/components/StageChecklistInline';

const STAGES: { key: Stage; label: string; icon: string }[] = [
  { key: 'S', label: '種', icon: '🌱' },
  { key: 'F', label: '広げる', icon: '🌊' },
  { key: 'R', label: '洞察', icon: '🪞' },
  { key: 'C', label: '実践', icon: '🔧' },
  { key: 'I', label: '結果', icon: '🌌' },
];

export default function VisionPage() {
  const [phase, setPhase] = useState<Phase>('initial');
  const [visions, setVisions] = useState<Vision[]>([]);
  const [openStage, setOpenStage] = useState<Stage | null>(null);
  const [editing, setEditing] = useState<Vision | null>(null);

  // ===== 一覧取得（未ログインなら匿名サインイン → トークン付与） =====
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
            return;
          }

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
          const visionsArr = (Array.isArray(rows) ? rows : []) as Vision[];

          const withThumbs = await enrichThumbs(visionsArr);
          setVisions(withThumbs);
        } catch (err) {
          console.error('GET visions error:', err);
          setVisions([]);
        }
      };

      unsubscribe = onAuthStateChanged(auth, load);
    })();

    return () => { if (unsubscribe) unsubscribe(); };
  }, [phase]);

  // iBoardの画像サムネを埋める
  async function enrichThumbs(rows: Vision[]): Promise<Vision[]> {
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

  // ===== D&D 移動処理（PUTでもトークン付与） =====
  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination) return;
    const { source, destination, draggableId } = result;
    if (source.droppableId === destination.droppableId) return;

    // 楽観的更新
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
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ vision_id: draggableId, stage: destination.droppableId }),
      });
    } catch (e) {
      console.error('PUT visions error:', e);
    }
  };

  // 保存後の反映（新規or更新）
  const upsertLocal = (saved: Vision) => {
    setVisions(prev => {
      const i = prev.findIndex(x => x.vision_id === saved.vision_id);
      const next = [...prev];
      if (i >= 0) next[i] = saved;
      else next.push(saved);
      return next;
    });
  };

  return (
    <div className="vision-shell">
      {/* 上部タブ */}
      <div className="vision-tabs">
        <button className={phase === 'initial' ? 'is-active' : ''} onClick={() => setPhase('initial')}>初期</button>
        <button className={phase === 'mid' ? 'is-active' : ''} onClick={() => setPhase('mid')}>中期</button>
        <button className={phase === 'final' ? 'is-active' : ''} onClick={() => setPhase('final')}>後期</button>
      </div>

      {/* カンバン */}
      <DragDropContext onDragEnd={handleDragEnd}>
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
                          {prov => (
                            // dragHandle を分離。カード本体クリックは編集モーダル
                            <div className="vision-card" ref={prov.innerRef} {...prov.draggableProps}>
                              <button
                                className="vision-drag-handle"
                                {...prov.dragHandleProps}
                                aria-label="ドラッグして並び替え"
                                onClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                              >⠿</button>

                              <div
                                className="vision-card-click"
                                onClick={() => setEditing(v)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => { if (e.key === 'Enter') setEditing(v); }}
                              >
                                {v.iboard_thumb && <img src={v.iboard_thumb} alt="" className="vision-thumb" />}
                                <div className="vision-title">{v.title}</div>
                              </div>

                              {/* 下段：橋渡しチェック（クリックはカードに伝播しない） */}
                              <div
                                className="vision-card-bridge"
                                onClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                              >
                                <StageChecklistInline visionId={v.vision_id!} from={v.stage} />
                              </div>
                            </div>
                          )}
                        </Draggable>
                      ))}
                    {provided.placeholder}
                  </div>

                  <button className="vision-add" onClick={() => setOpenStage(stage.key)}>＋カード</button>
                </div>
              )}
            </Droppable>
          ))}
        </div>
      </DragDropContext>

      {/* 新規作成モーダル */}
      {openStage && (
        <VisionModal
          isOpen={true}
          defaultPhase={phase}
          defaultStage={openStage}
          userCode={''}
          onClose={() => setOpenStage(null)}
          onSaved={upsertLocal}
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
          onSaved={(v) => { upsertLocal(v); setEditing(null); }}
        />
      )}
    </div>
  );
}

