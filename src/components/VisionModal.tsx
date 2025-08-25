'use client';

import { useEffect, useState } from 'react';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import IboardPicker from './IboardPicker';
import './VisionModal.css';

import type { Vision, Phase, Stage, Status } from '@/types/vision';

type VisionModalProps = {
  isOpen: boolean;
  defaultPhase: Phase;
  defaultStage: Stage;
  userCode: string;
  initial?: Vision | null;
  onClose: () => void;
  onSaved?: (saved: any) => void;
};

const STATUS_LIST: Status[] = ['検討中','実践中','迷走中','順調','ラストスパート','達成','破棄'];

// ---- 追加: 橋渡しチェックリストのデフォルト定義 ----
function nextStageOf(s: Stage): Stage | null {
  const order: Stage[] = ['S', 'F', 'R', 'C', 'I'];
  const i = order.indexOf(s);
  return i >= 0 && i < order.length - 1 ? order[i + 1] : null;
}
function defaultCriteria(from: Stage, to: Stage, vision_id: string) {
  // 最小のデフォルト（後で編集可能）
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
    return [
      { vision_id, from_stage: 'R', to_stage: 'C', title: '実行タスクを3件切る', required_days: 3, required: true, order_index: 0 },
    ];
  }
  if (from === 'C' && to === 'I') {
    return [
      { vision_id, from_stage: 'C', to_stage: 'I', title: '今週2回実行する', required_days: 2, required: true, order_index: 0 },
      { vision_id, from_stage: 'C', to_stage: 'I', title: '成果を1回共有する', required_days: 1, required: true, order_index: 1 },
    ];
  }
  return [];
}
// /api/vision-criteria に一括投入
async function seedStageCriteria(vision_id: string, from_stage: Stage, token: string) {
  const to = nextStageOf(from_stage);
  if (!to) return; // I の場合は何もしない
  const bulk = defaultCriteria(from_stage, to, vision_id);
  if (bulk.length === 0) return;
  await fetch('/api/vision-criteria', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ bulk }),
  });
}

export default function VisionModal({
  isOpen, defaultPhase, defaultStage, userCode, initial, onClose, onSaved,
}: VisionModalProps) {
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  const [vision, setVision] = useState<Vision>(() => ({
    phase: initial?.phase ?? defaultPhase,
    stage: initial?.stage ?? defaultStage,
    title: initial?.title ?? '',
    detail: initial?.detail ?? '',
    intention: initial?.intention ?? '',
    supplement: initial?.supplement ?? '',
    status: (initial?.status as Status) ?? '検討中',
    summary: initial?.summary ?? '',
    iboard_post_id: initial?.iboard_post_id ?? null,
    iboard_thumb: initial?.iboard_thumb ?? null,
    q_code: initial?.q_code ?? undefined,
    vision_id: initial?.vision_id,
  }));

  useEffect(() => {
    const auth = getAuth();
    return onAuthStateChanged(auth, (u) => { setLoggedIn(!!u); setAuthReady(true); });
  }, []);

  useEffect(() => {
    if (!isOpen || !initial) return;
    setVision(v => ({
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

  if (!isOpen) return null;

  const handleChange = (k: keyof Vision, val: any) =>
    setVision(prev => ({ ...prev, [k]: val }));

  const handlePickIboard = (postId: string, thumb: string) => {
    setVision(prev => ({ ...prev, iboard_post_id: postId, iboard_thumb: thumb }));
  };

  const handleSave = async () => {
    try {
      const auth = getAuth();
      if (!auth.currentUser) {
        await signInAnonymously(auth); // 未ログインなら匿名で
      }
      const token = await auth.currentUser!.getIdToken();

      if (!vision.title || !vision.title.trim()) {
        setErrorMsg('タイトルを入力してください');
        return;
      }

      setSaving(true);
      setErrorMsg(null);

      const isUpdate = Boolean(vision.vision_id);
      const method = isUpdate ? 'PUT' : 'POST';

      const payload = {
        vision_id: vision.vision_id,
        phase: vision.phase,
        stage: vision.stage,
        title: vision.title,
        detail: vision.detail,
        intention: vision.intention,
        supplement: vision.supplement,
        status: vision.status,
        summary: vision.summary,
        iboard_post_id: vision.iboard_post_id,
        q_code: vision.q_code, // POSTで未指定ならAPI側が自動生成
      };

      const res = await fetch('/api/visions', {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '保存に失敗しました');

      // ★ 新規作成時のみ：橋渡しチェックリストのデフォルトを投入
      if (!isUpdate && data?.vision_id && payload.stage) {
        try {
          await seedStageCriteria(String(data.vision_id), payload.stage as Stage, token);
        } catch (seedingErr) {
          // ここは致命ではないのでログのみ（UIは成功扱い）
          console.warn('seedStageCriteria warning:', seedingErr);
        }
      }

      onSaved?.(data);
      onClose();
    } catch (e: any) {
      setErrorMsg(e.message || 'エラーが発生しました');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="vmd-backdrop" role="dialog" aria-modal="true">
      <div className="vmd-modal">
        <div className="vmd-header">
          <div className="vmd-title">{vision.vision_id ? 'Visionを編集' : 'Visionを作成'}</div>
          <button className="vmd-close" onClick={onClose} aria-label="閉じる">×</button>
        </div>

        <div className="vmd-body">
          <label className="vmd-label">タイトル（ビジョン）</label>
          <input className="vmd-input" value={vision.title}
            onChange={(e) => handleChange('title', e.target.value)} />

          <div className="vmd-image-block">
            {vision.iboard_thumb ? (
              <img src={vision.iboard_thumb} alt="" className="vmd-thumb" />
            ) : (
              <div className="vmd-thumb placeholder">（画像未選択）</div>
            )}
            <div className="vmd-pick">
              <IboardPicker
                userCode={userCode}
                selectedPostId={vision.iboard_post_id ?? undefined}
                onSelect={handlePickIboard}
              />
            </div>
          </div>

          <label className="vmd-label">詳細</label>
          <textarea className="vmd-textarea" rows={3}
            value={vision.detail} onChange={(e) => handleChange('detail', e.target.value)} />

          <label className="vmd-label">意図メモ</label>
          <textarea className="vmd-textarea" rows={3}
            value={vision.intention} onChange={(e) => handleChange('intention', e.target.value)} />

          <label className="vmd-label">補足</label>
          <textarea className="vmd-textarea" rows={2}
            value={vision.supplement} onChange={(e) => handleChange('supplement', e.target.value)} />

          <label className="vmd-label">ステータス</label>
          <select className="vmd-select" value={vision.status}
            onChange={(e) => handleChange('status', e.target.value as Status)}>
            {STATUS_LIST.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          <label className="vmd-label">総評</label>
          <textarea className="vmd-textarea" rows={3}
            value={vision.summary} onChange={(e) => handleChange('summary', e.target.value)} />

          {errorMsg && <div className="vmd-error">⚠ {errorMsg}</div>}
        </div>

        <div className="vmd-footer">
          <button className="vmd-btn ghost" onClick={onClose}>キャンセル</button>
          <button className="vmd-btn primary"
            onClick={handleSave}
            disabled={saving || !authReady || !vision.title?.trim()}
            title={!authReady ? '認証初期化中…' : undefined}>
            {saving ? '保存中…' : '保存する'}
          </button>
        </div>
      </div>
    </div>
  );
}
