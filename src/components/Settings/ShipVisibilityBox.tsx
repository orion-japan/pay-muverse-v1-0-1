'use client';

import { useEffect, useState } from 'react';
import { getAuth } from 'firebase/auth';

type Plan = 'free' | 'regular' | 'premium' | 'master' | 'admin';
/** ★ サーバと統一：pair | shipmates | all */
type Visibility = 'pair' | 'shipmates' | 'all';

type Props = {
  planStatus: Plan;
  /** サーバ取得失敗時のフォールバック */
  fallbackVisibility?: Visibility; // default 'pair'
};

export default function ShipVisibilityBox({
  planStatus,
  fallbackVisibility = 'pair',
}: Props) {
  const [loading, setLoading] = useState(true);
  const [visibility, setVisibility] = useState<Visibility>(fallbackVisibility);
  const [saving, setSaving] = useState<Visibility | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 現在値のロード（GET /api/ship-visibility）
  useEffect(() => {
    let mounted = true;
    const ac = new AbortController();

    (async () => {
      try {
        const auth = getAuth();
        const user = auth.currentUser;
        if (!user) { if (mounted) setLoading(false); return; }
        const token = await user.getIdToken(true);

        const res = await fetch('/api/ship-visibility', {
          headers: { Authorization: `Bearer ${token}` },
          signal: ac.signal,
          cache: 'no-store',
        });

        // 403 & needRefresh → トークン再取得して1回だけリトライ
        if (res.status === 403) {
          try {
            const j = await res.clone().json().catch(() => ({}));
            if (j?.needRefresh) {
              const idt = await user.getIdToken(true);
              const res2 = await fetch('/api/ship-visibility', {
                headers: { Authorization: `Bearer ${idt}` },
                cache: 'no-store',
                signal: ac.signal,
              });
              if (res2.ok) {
                const j2 = await res2.json().catch(() => null);
                if (mounted && (j2?.ship_visibility === 'pair' || j2?.ship_visibility === 'shipmates' || j2?.ship_visibility === 'all')) {
                  setVisibility(j2.ship_visibility);
                }
                return;
              }
            }
          } catch {}
        }

        if (!res.ok) {
          const raw = await res.text().catch(() => '');
          console.warn('GET /api/ship-visibility failed:', raw);
          if (mounted) setError('現在値の取得に失敗しました。後でもう一度お試しください。');
          return;
        }

        const j = await res.json().catch(() => null);
        if (mounted && (j?.ship_visibility === 'pair' || j?.ship_visibility === 'shipmates' || j?.ship_visibility === 'all')) {
          setVisibility(j.ship_visibility as Visibility);
        }
      } catch (e: any) {
        const aborted = e?.name === 'AbortError' || /abort/i.test(String(e?.message));
        if (!aborted) {
          console.warn('ship-visibility load error:', e);
          if (mounted) setError('現在値の取得に失敗しました。');
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => { mounted = false; ac.abort(); };
  }, []);

  // プランに応じたロック（仕様：shipmates=課金以上 / all=master+）
  const disabled = {
    shipmates: planStatus === 'free',
    all: !(planStatus === 'master' || planStatus === 'admin'),
  } as const;

  const handlePick = async (v: Visibility) => {
    if (saving || loading) return;
    if ((v === 'shipmates' && disabled.shipmates) || (v === 'all' && disabled.all)) return;

    try {
      setSaving(v);
      setError(null);

      // 楽観更新
      const prev = visibility;
      setVisibility(v);

      const auth = getAuth();
      const user = auth.currentUser;
      if (!user) throw new Error('ログインが必要です');
      let token = await user.getIdToken(true);

      let res = await fetch('/api/update-ship-visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ship_visibility: v }), // ★ キー名もサーバと統一
      });

      // 403 needRefresh → 1回だけ再発行して再送
      if (res.status === 403) {
        const j = await res.clone().json().catch(() => ({}));
        if (j?.needRefresh) {
          token = await user.getIdToken(true);
          res = await fetch('/api/update-ship-visibility', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ ship_visibility: v }),
          });
        }
      }

      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        console.warn('POST /api/update-ship-visibility failed:', raw);
        // 失敗→ロールバック
        setVisibility(prev);
        throw new Error('保存に失敗しました。時間をおいて再度お試しください。');
      }
    } catch (e: any) {
      setError(e?.message || '保存に失敗しました。');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="ship-visibility-box">
      <h3 className="sv-title">🚢 シップ公開範囲</h3>
      <p className="sv-caption">誰にシップ関係（FF/RRの種類を含む）を見せるかを選べます。</p>

      <div className="sv-grid">
        <button
          type="button"
          className={`sv-card ${visibility === 'pair' ? 'active' : ''}`}
          onClick={() => handlePick('pair')}
          disabled={saving !== null || loading}
          aria-pressed={visibility === 'pair'}
        >
          <div className="sv-emoji">👥</div>
          <div className="sv-head">ペアのみ</div>
          <div className="sv-desc">相手と自分だけに表示</div>
        </button>

        <button
          type="button"
          className={`sv-card ${visibility === 'shipmates' ? 'active' : ''} ${disabled.shipmates ? 'locked' : ''}`}
          onClick={() => handlePick('shipmates')}
          disabled={saving !== null || loading || disabled.shipmates}
          title={disabled.shipmates ? '課金ユーザー限定' : ''}
          aria-pressed={visibility === 'shipmates'}
          aria-disabled={disabled.shipmates}
        >
          <div className="sv-emoji">🤝</div>
          <div className="sv-head">シップメイトまで</div>
          <div className="sv-desc">F以上の両想い相手（課金ユーザー）</div>
          {disabled.shipmates && <span className="sv-badge">🔒</span>}
        </button>

        <button
          type="button"
          className={`sv-card ${visibility === 'all' ? 'active' : ''} ${disabled.all ? 'locked' : ''}`}
          onClick={() => handlePick('all')}
          disabled={saving !== null || loading || disabled.all}
          title={disabled.all ? 'Master 以上限定' : ''}
          aria-pressed={visibility === 'all'}
          aria-disabled={disabled.all}
        >
          <div className="sv-emoji">🌍</div>
          <div className="sv-head">全体公開</div>
          <div className="sv-desc">Muverse の全ユーザーに表示</div>
          {disabled.all && <span className="sv-badge">🔒</span>}
        </button>
      </div>

      {loading && <p className="sv-note">読み込み中…</p>}
      {saving && <p className="sv-note">保存中…</p>}
      {error && <p className="sv-error">⚠ {error}</p>}

      <style jsx>{`
        .ship-visibility-box {
          border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; background: #fff;
        }
        .sv-title { font-weight: 700; margin-bottom: 6px; }
        .sv-caption { color: #6b7280; font-size: 13px; margin-bottom: 12px; }
        .sv-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
        .sv-card { border: 1px solid #e5e7eb; border-radius: 10px; background: #fafafa; padding: 14px 10px;
          text-align: center; cursor: pointer; position: relative; transition: transform .08s, box-shadow .12s, border-color .12s; }
        .sv-card:hover { transform: translateY(-1px); box-shadow: 0 2px 10px rgba(0,0,0,.04); }
        .sv-card.active { border-color: #3b82f6; background: #eef4ff; }
        .sv-card.locked { opacity: .6; cursor: not-allowed; }
        .sv-emoji { font-size: 20px; margin-bottom: 6px; }
        .sv-head { font-weight: 600; }
        .sv-desc { font-size: 12px; color: #6b7280; }
        .sv-badge { position: absolute; top: 8px; right: 8px; font-size: 12px; }
        .sv-note { margin-top: 8px; font-size: 12px; color: #6b7280; }
        .sv-error { margin-top: 8px; font-size: 13px; color: #dc2626; }
        @media (max-width: 540px) { .sv-grid { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}
