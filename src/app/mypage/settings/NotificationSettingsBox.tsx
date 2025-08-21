'use client';

import { useEffect, useState } from 'react';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import type { EnsureResult } from '@/lib/push/subscribePush';
import { ensurePushSubscribed } from '@/lib/push/subscribePush';

type Consent = {
  push_enabled: boolean;
  vibration: boolean;
  notify_self_talk: 'all' | 'friends' | 'none';
  notify_i_board: 'all' | 'friends' | 'none';
  allow_f_talk: boolean;
  allow_r_talk: boolean;
  notify_event: boolean;
  notify_live: boolean;
  notify_ai: boolean;
  notify_credit: boolean;
};

const DEFAULTS: Required<Consent> = {
  push_enabled: true,
  vibration: true,
  notify_self_talk: 'all',
  notify_i_board: 'all',
  allow_f_talk: true,
  allow_r_talk: true,
  notify_event: true,
  notify_live: true,
  notify_ai: true,
  notify_credit: true,
};

// ✅ 型ガード
const isFail = (r: EnsureResult): r is { ok: false; reason: string } => r.ok === false;

export default function NotificationSettingsBox() {
  const [uid, setUid] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [consent, setConsent] = useState<Consent>(DEFAULTS);
  const [msg, setMsg] = useState<string | null>(null);

  // ✅ Firebaseのログイン状態を監視してUIDを確定させる
  useEffect(() => {
    const auth = getAuth();
    const unsub = onAuthStateChanged(auth, (u) => {
      setUid(u?.uid ?? null);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // ✅ UID が取れてから設定を取得
  useEffect(() => {
    if (!authReady) return;
    let mounted = true;
    const ac = new AbortController();

    (async () => {
      setLoading(true);
      try {
        if (!uid) {
          if (mounted) setConsent(DEFAULTS);
          return;
        }
        const res = await fetch(`/api/notification-settings?uid=${uid}`, {
          signal: ac.signal,
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!mounted) return;
        setConsent({ ...DEFAULTS, ...data });
      } catch (e: any) {
        if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') return;
        console.error(e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
      ac.abort();
    };
  }, [authReady, uid]);

  // ✅ 保存
  const handleSave = async () => {
    if (!uid) {
      setMsg('ログインが必要です。');
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      if (consent.push_enabled) {
        const r: EnsureResult = await ensurePushSubscribed(uid);
        if (isFail(r)) throw new Error(`Push購読失敗: ${r.reason}`);
      }
      const res = await fetch('/api/notification-settings/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, ...consent }),
      });
      if (!res.ok) throw new Error(`保存失敗: ${res.status}`);
      setMsg('保存しました');
    } catch (e: any) {
      console.error(e);
      setMsg(e?.message ?? '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  // 表示
  if (!authReady) return null;
  if (!uid) {
    return (
      <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 6px 16px rgba(0,0,0,.06)', padding: 12 }}>
        <h3 style={{ marginBottom: 8 }}>通知・公開設定</h3>
        <div style={{ color: '#666' }}>ログインが必要です。</div>
      </div>
    );
  }
  if (loading) return null;

  return (
    <div style={{
      background: '#fff', borderRadius: 12, boxShadow: '0 6px 16px rgba(0,0,0,.06)',
      padding: 12
    }}>
      <h3 style={{ marginBottom: 8 }}>通知・公開設定</h3>

      <div style={{ display: 'grid', gap: 10 }}>
        <label>
          <input
            type="checkbox"
            checked={consent.push_enabled}
            onChange={(e) => setConsent({ ...consent, push_enabled: e.target.checked })}
          /> プッシュ通知を有効にする
        </label>

        <label>
          <input
            type="checkbox"
            checked={consent.vibration}
            onChange={(e) => setConsent({ ...consent, vibration: e.target.checked })}
          /> 通知時にバイブレーション
        </label>

        <div>
          <div>SelfTalk 通知範囲</div>
          <select
            value={consent.notify_self_talk}
            onChange={(e) =>
              setConsent({ ...consent, notify_self_talk: e.target.value as Consent['notify_self_talk'] })
            }
          >
            <option value="all">全員</option>
            <option value="friends">友達まで</option>
            <option value="none">通知しない</option>
          </select>
        </div>

        <div>
          <div>Create（I Board）通知範囲</div>
          <select
            value={consent.notify_i_board}
            onChange={(e) =>
              setConsent({ ...consent, notify_i_board: e.target.value as Consent['notify_i_board'] })
            }
          >
            <option value="all">全員</option>
            <option value="friends">友達まで</option>
            <option value="none">通知しない</option>
          </select>
        </div>

        <label>
          <input
            type="checkbox"
            checked={consent.allow_f_talk}
            onChange={(e) => setConsent({ ...consent, allow_f_talk: e.target.checked })}
          /> F Talk の通知を受け取る
        </label>

        <label>
          <input
            type="checkbox"
            checked={consent.allow_r_talk}
            onChange={(e) => setConsent({ ...consent, allow_r_talk: e.target.checked })}
          /> R Talk の通知を受け取る
        </label>

        <label>
          <input
            type="checkbox"
            checked={consent.notify_event}
            onChange={(e) => setConsent({ ...consent, notify_event: e.target.checked })}
          /> 共鳴会の通知
        </label>

        <label>
          <input
            type="checkbox"
            checked={consent.notify_live}
            onChange={(e) => setConsent({ ...consent, notify_live: e.target.checked })}
          /> ライヴ配信の通知
        </label>

        <label>
          <input
            type="checkbox"
            checked={consent.notify_ai}
            onChange={(e) => setConsent({ ...consent, notify_ai: e.target.checked })}
          /> AIからの通知
        </label>

        <label>
          <input
            type="checkbox"
            checked={consent.notify_credit}
            onChange={(e) => setConsent({ ...consent, notify_credit: e.target.checked })}
          /> クレジット（サブスク切れ）の通知
        </label>

        <div>
          <button onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
          {msg && <div style={{ fontSize: 12, color: '#555', marginTop: 6 }}>{msg}</div>}
        </div>
      </div>
    </div>
  );
}
