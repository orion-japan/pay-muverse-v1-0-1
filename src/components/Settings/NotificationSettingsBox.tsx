'use client';

import { useEffect, useState } from 'react';
import { getAuth } from 'firebase/auth';

type Plan = 'free' | 'regular' | 'premium' | 'master' | 'admin';

type Props = {
  planStatus: Plan;
};

// UIのセレクト値（all / mates）⇔ サーバの値（all / shipmates）
const uiToServer = (v: 'all' | 'mates') => (v === 'mates' ? 'shipmates' : 'all');
const serverToUi = (v?: string): 'all' | 'mates' => (v === 'shipmates' ? 'mates' : 'all');

// ===== 認証ユーティリティ（共通化） =====
async function getIdTokenSafe(force = false): Promise<string | null> {
  try {
    const user = getAuth().currentUser;
    if (!user) return null;
    return await user.getIdToken(force);
  } catch {
    return null;
  }
}
function hasSessionCookie(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    return document.cookie.split(';').some((c) => c.trim().startsWith('__session='));
  } catch {
    return false;
  }
}
async function ensureSessionIfNeeded() {
  // Bearer も __session も無いときだけ軽く叩いておく（失敗しても無視）
  if (hasSessionCookie()) return;
  try {
    await fetch('/api/resolve-usercode', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {}
}
async function authedFetch(input: RequestInfo, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  const token = await getIdTokenSafe(false);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  else if (!hasSessionCookie()) await ensureSessionIfNeeded();

  const res0 = await fetch(input, {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });

  // 初回だけ 401/403 をワンショット再試行
  if (res0.status === 401 || res0.status === 403) {
    const t2 = await getIdTokenSafe(true);
    const headers2 = new Headers(init.headers || {});
    if (t2) headers2.set('Authorization', `Bearer ${t2}`);
    return fetch(input, {
      ...init,
      headers: headers2,
      credentials: 'include',
      cache: 'no-store',
    });
  }
  return res0;
}

export default function NotificationSettingsBox({ planStatus }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // フォーム状態（構造はそのまま）
  const [pushEnabled, setPushEnabled] = useState(true);
  const [vibrate, setVibrate] = useState(true);
  const [selfScope, setSelfScope] = useState<'all' | 'mates'>('all');
  const [createScope, setCreateScope] = useState<'all' | 'mates'>('all');
  const [fTalk, setFTalk] = useState(true);
  const [rTalk, setRTalk] = useState(true);
  const [resonance, setResonance] = useState(true);
  const [writing, setWriting] = useState(true);
  const [ai, setAi] = useState(true);
  const [credit, setCredit] = useState(true);

  // 初期読み込み（GET）
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);

        const res = await authedFetch('/api/notification-settings', { method: 'GET' });

        if (alive && res.ok) {
          const j = (await res.json().catch(() => ({}))) as any;

          // サーバのキー名は任意。存在すれば反映、無ければ初期値のまま
          if (typeof j.push_enabled === 'boolean') setPushEnabled(j.push_enabled);
          if (typeof j.vibrate === 'boolean') setVibrate(j.vibrate);
          if (j.self_scope) setSelfScope(serverToUi(j.self_scope));
          if (j.create_scope) setCreateScope(serverToUi(j.create_scope));
          if (typeof j.notify_ftalk === 'boolean') setFTalk(j.notify_ftalk);
          if (typeof j.notify_rtalk === 'boolean') setRTalk(j.notify_rtalk);
          if (typeof j.notify_resonance === 'boolean') setResonance(j.notify_resonance);
          if (typeof j.notify_writing === 'boolean') setWriting(j.notify_writing);
          if (typeof j.notify_ai === 'boolean') setAi(j.notify_ai);
          if (typeof j.notify_credit === 'boolean') setCredit(j.notify_credit);
        } else if (alive) {
          setErrorMsg('現在値の取得に失敗しました。後でもう一度お試しください。');
        }
      } catch {
        // 読み込み失敗時は初期値のまま使えるようにしておく
        if (alive) setErrorMsg('現在値の取得に失敗しました。後でもう一度お試しください。');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function handleSave() {
    try {
      setSaving(true);
      setErrorMsg(null);

      const payload = {
        push_enabled: pushEnabled,
        vibrate,
        self_scope: uiToServer(selfScope), // 'mates' → 'shipmates'
        create_scope: uiToServer(createScope), // 'mates' → 'shipmates'
        notify_ftalk: fTalk,
        notify_rtalk: rTalk,
        notify_resonance: resonance,
        notify_writing: writing,
        notify_ai: ai,
        notify_credit: credit,
      };

      const res = await authedFetch('/api/notification-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        console.warn('POST /api/notification-settings failed:', raw);
        throw new Error('保存に失敗しました。時間をおいて再度お試しください。');
      }
    } catch (e: any) {
      setErrorMsg(e?.message || '保存に失敗しました。');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div>読み込み中...</div>;

  return (
    <section style={{ border: '1px solid #eee', borderRadius: 12, padding: 16 }}>
      <h3 style={{ marginBottom: 8 }}>通知・公開設定</h3>

      <label>
        <input
          type="checkbox"
          checked={pushEnabled}
          onChange={(e) => setPushEnabled(e.target.checked)}
          disabled={saving}
        />{' '}
        プッシュ通知を有効にする
      </label>
      <br />

      <label>
        <input
          type="checkbox"
          checked={vibrate}
          onChange={(e) => setVibrate(e.target.checked)}
          disabled={saving}
        />{' '}
        通知時にバイブレーション
      </label>
      <br />

      <div style={{ marginTop: 8 }}>
        <label>SelfTalk 通知範囲</label>
        <br />
        <select
          value={selfScope}
          onChange={(e) => setSelfScope(e.target.value as 'all' | 'mates')}
          disabled={saving}
        >
          <option value="all">全員</option>
          <option value="mates">シップメイトのみ</option>
        </select>
      </div>

      <div style={{ marginTop: 8 }}>
        <label>Create（I Board）通知範囲</label>
        <br />
        <select
          value={createScope}
          onChange={(e) => setCreateScope(e.target.value as 'all' | 'mates')}
          disabled={saving}
        >
          <option value="all">全員</option>
          <option value="mates">シップメイトのみ</option>
        </select>
      </div>

      <div style={{ marginTop: 8 }}>
        <label>
          <input
            type="checkbox"
            checked={fTalk}
            onChange={(e) => setFTalk(e.target.checked)}
            disabled={saving}
          />{' '}
          F Talk の通知を受け取る
        </label>
        <br />
        <label>
          <input
            type="checkbox"
            checked={rTalk}
            onChange={(e) => setRTalk(e.target.checked)}
            disabled={saving}
          />{' '}
          R Talk の通知を受け取る
        </label>
        <br />
        <label>
          <input
            type="checkbox"
            checked={resonance}
            onChange={(e) => setResonance(e.target.checked)}
            disabled={saving}
          />{' '}
          共鳴の通知
        </label>
        <br />
        <label>
          <input
            type="checkbox"
            checked={writing}
            onChange={(e) => setWriting(e.target.checked)}
            disabled={saving}
          />{' '}
          ライティングの通知
        </label>
        <br />
        <label>
          <input
            type="checkbox"
            checked={ai}
            onChange={(e) => setAi(e.target.checked)}
            disabled={saving}
          />{' '}
          AIからの通知
        </label>
        <br />
        <label>
          <input
            type="checkbox"
            checked={credit}
            onChange={(e) => setCredit(e.target.checked)}
            disabled={saving}
          />{' '}
          クレジット（サブスク切れ）の通知
        </label>
      </div>

      <button style={{ marginTop: 12 }} onClick={handleSave} disabled={saving}>
        {saving ? '保存中…' : '保存'}
      </button>

      {errorMsg && <div style={{ color: 'red', marginTop: 8 }}>{errorMsg}</div>}
    </section>
  );
}
