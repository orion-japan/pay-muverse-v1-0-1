'use client';

import { useEffect, useState } from 'react';
import { getAuth } from 'firebase/auth';

type Plan = 'free' | 'regular' | 'premium' | 'master' | 'admin';
type Visibility = 'self' | 'pair' | 'mates' | 'public';

type Props = {
  /** 課金プラン（free / regular / premium / master / admin） */
  planStatus: Plan;
  /** 初期表示のフォールバック（サーバから取得できない時の保険）。省略可 */
  fallbackVisibility?: Visibility; // default 'pair'
};

/**
 * マイページ > 設定: シップ公開範囲 BOX
 * - クリックで即保存（/api/update-ship-visibility）
 * - 初回マウント時に現在値を取得（/api/ship-visibility）
 * - プランによって一部オプションをロック
 */
export default function ShipVisibilityBox({ planStatus, fallbackVisibility = 'pair' }: Props) {
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
        if (!user) {
          if (mounted) setLoading(false);
          return;
        }
        const token = await user.getIdToken(true);
        const res = await fetch('/api/ship-visibility', {
          headers: { Authorization: `Bearer ${token}` },
          signal: ac.signal,
        });
        if (!res.ok) {
          // コンソールには詳細、UIには短い文
          const raw = await res.text().catch(() => '');
          // eslint-disable-next-line no-console
          console.error('GET /api/ship-visibility failed:', raw);
          if (mounted) setError('現在値の取得に失敗しました。後でもう一度お試しください。');
          return;
        }
        const j = await res.json().catch(() => null);
        if (mounted && j?.ship_visibility) {
          setVisibility(j.ship_visibility as Visibility);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('ship-visibility load error:', e);
        if (mounted) setError('現在値の取得に失敗しました。');
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
      ac.abort();
    };
  }, []);

  // プランに応じたロック
  const disabled = {
    mates: planStatus === 'free', // 課金ユーザーのみ
    public: !(planStatus === 'master' || planStatus === 'admin'), // Master 以上のみ
  };

  const handlePick = async (v: Visibility) => {
    if (saving || loading) return;
    if ((v === 'mates' && disabled.mates) || (v === 'public' && disabled.public)) return;

    try {
      setSaving(v);
      setError(null);

      // 先に UI を反映（楽観更新）
      setVisibility(v);

      const auth = getAuth();
      const user = auth.currentUser;
      if (!user) throw new Error('ログインが必要です');
      const token = await user.getIdToken(true);

      const res = await fetch('/api/update-ship-visibility', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ship_visibility: v }),
      });

      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        // eslint-disable-next-line no-console
        console.error('POST /api/update-ship-visibility failed:', raw);
        throw new Error('保存に失敗しました。時間をおいて再度お試しください。');
      }
    } catch (e: any) {
      setError(e?.message || '保存に失敗しました。');
      // 失敗時は必要なら UI を元に戻す（今回は直前の表示を維持）
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="ship-visibility-box">
      <h3 className="sv-title">🚢 シップ公開範囲</h3>
      <p className="sv-caption">誰に自分のシップ関係（FF/RRなどの種類を含む）を見せるかを選べます。</p>

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
          className={`sv-card ${visibility === 'mates' ? 'active' : ''} ${disabled.mates ? 'locked' : ''}`}
          onClick={() => handlePick('mates')}
          disabled={saving !== null || loading || disabled.mates}
          title={disabled.mates ? '課金ユーザー限定' : ''}
          aria-pressed={visibility === 'mates'}
          aria-disabled={disabled.mates}
        >
          <div className="sv-emoji">🤝</div>
          <div className="sv-head">シップメイトまで</div>
          <div className="sv-desc">F以上の両想い相手（課金ユーザー）</div>
          {disabled.mates && <span className="sv-badge">🔒</span>}
        </button>

        <button
          type="button"
          className={`sv-card ${visibility === 'public' ? 'active' : ''} ${disabled.public ? 'locked' : ''}`}
          onClick={() => handlePick('public')}
          disabled={saving !== null || loading || disabled.public}
          title={disabled.public ? 'Master 以上限定' : ''}
          aria-pressed={visibility === 'public'}
          aria-disabled={disabled.public}
        >
          <div className="sv-emoji">🌍</div>
          <div className="sv-head">全体公開</div>
          <div className="sv-desc">Muverse の全ユーザーに表示</div>
          {disabled.public && <span className="sv-badge">🔒</span>}
        </button>
      </div>

      {loading && <p className="sv-note">読み込み中…</p>}
      {saving && <p className="sv-note">保存中…</p>}
      {error && <p className="sv-error">⚠ {error}</p>}

      <style jsx>{`
        .ship-visibility-box {
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          padding: 16px;
          background: #fff;
        }
        .sv-title { font-weight: 700; margin-bottom: 6px; }
        .sv-caption { color: #6b7280; font-size: 13px; margin-bottom: 12px; }
        .sv-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
        }
        .sv-card {
          border: 1px solid #e5e7eb;
          border-radius: 10px;
          background: #fafafa;
          padding: 14px 10px;
          text-align: center;
          cursor: pointer;
          position: relative;
          transition: transform .08s ease, box-shadow .12s ease, border-color .12s ease;
        }
        .sv-card:hover { transform: translateY(-1px); box-shadow: 0 2px 10px rgba(0,0,0,.04); }
        .sv-card.active { border-color: #3b82f6; background: #eef4ff; }
        .sv-card.locked { opacity: .6; cursor: not-allowed; }
        .sv-emoji { font-size: 20px; margin-bottom: 6px; }
        .sv-head { font-weight: 600; }
        .sv-desc { font-size: 12px; color: #6b7280; }
        .sv-badge { position: absolute; top: 8px; right: 8px; font-size: 12px; }
        .sv-note { margin-top: 8px; font-size: 12px; color: #6b7280; }
        .sv-error { margin-top: 8px; font-size: 13px; color: #dc2626; }
        @media (max-width: 540px) {
          .sv-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
