'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { getAuth } from 'firebase/auth';
import SafeImage from '@/components/common/SafeImage';

type SummaryRow = { pair: string; cnt: number };
type DetailRow = {
  user_code: string;
  display_name: string | null; // OFF の人は null
  avatar_url: string | null;
  from_me: 'F' | 'R' | 'C' | 'I';
  to_me: 'F' | 'R' | 'C' | 'I';
};

type Props = {
  profile: { user_code: string };
  /** ルーティング上書きしたい場合だけ渡す */
  routes?: {
    profile: (code: string) => string; // 名前クリック
    posts: (code: string) => string; // 画像クリック
  };
};

const pairClass = (pair: string) => {
  if (pair === 'FF') return 'pair-badge ff';
  if (pair === 'FR' || pair === 'RF') return 'pair-badge fr';
  if (pair === 'RR') return 'pair-badge rr';
  return 'pair-badge other';
};

export default function ProfileFriends({ profile, routes }: Props) {
  const [summary, setSummary] = useState<SummaryRow[] | null>(null);
  const [details, setDetails] = useState<DetailRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPaid, setIsPaid] = useState<boolean>(false);

  // 既定の遷移先（必要なら page 側で props.routes を渡して調整できます）
  const toProfile = routes?.profile ?? ((code: string) => `/profile/${code}`);
  const toPosts = routes?.posts ?? ((code: string) => `/self?user=${code}`);

  useEffect(() => {
    let aborted = false;

    (async () => {
      try {
        setLoading(true);
        const auth = getAuth();
        const user = auth.currentUser;
        const token = user ? await user.getIdToken(true) : null;

        const res = await fetch(`/api/shipmates?owner=${encodeURIComponent(profile.user_code)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) throw new Error(await res.text().catch(() => ''));

        // 課金ユーザーには配列、free には {summary:[...]}
        const j = await res.json();

        if (!aborted) {
          if (Array.isArray(j)) {
            setIsPaid(true);
            setDetails(j as DetailRow[]);
            setSummary(null);
          } else {
            setIsPaid(false);
            setSummary((j.summary || []) as SummaryRow[]);
            setDetails(null);
          }
        }
      } catch {
        if (!aborted) {
          setSummary([]);
          setDetails([]);
        }
      } finally {
        if (!aborted) setLoading(false);
      }
    })();

    return () => {
      aborted = true;
    };
  }, [profile.user_code]);

  return (
    <div>
      <h3 className="mu-section-title">シップメイト</h3>

      {loading && <div className="mu-muted">読み込み中…</div>}

      {!loading && !isPaid && summary && (
        <div className="summary-grid">
          {summary.length === 0 && <div className="mu-muted">両想いの相手はいません。</div>}
          {summary.map((s) => (
            <div key={s.pair} className="summary-card">
              <span className={pairClass(s.pair)}>{s.pair}</span>
              <div className="summary-num">{s.cnt}</div>
            </div>
          ))}
        </div>
      )}

      {!loading && isPaid && details && (
        <>
          {details.length === 0 && <div className="mu-muted">両想いの相手はいません。</div>}
          <ul className="shipmates-list">
            {details.map((m) => {
              const pair = `${m.from_me}${m.to_me}`;
              const displayName = m.display_name ?? '匿名さん';
              const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
              const avatar =
                m.avatar_url && /^https?:\/\//i.test(m.avatar_url)
                  ? m.avatar_url
                  : m.avatar_url
                    ? `${base}/storage/v1/object/public/avatars/${m.avatar_url}`
                    : '';

              return (
                <li key={m.user_code} className="shipmate-item">
                  {/* 画像 → 投稿一覧へ */}
                  <Link
                    href={toPosts(m.user_code)}
                    className="shipmate-left"
                    aria-label={`${displayName} の投稿一覧`}
                  >
                    {avatar ? (
                      <SafeImage
                        src={avatar}
                        alt={displayName}
                        aspectRatio="1/1"
                        className="shipmate-avatar"
                      />
                    ) : (
                      <div className="shipmate-avatar placeholder" />
                    )}
                  </Link>

                  {/* 名前・コード → プロフィールへ */}
                  <div className="shipmate-center">
                    <Link href={toProfile(m.user_code)} className="shipmate-name mu-link">
                      {displayName}
                    </Link>
                    <div className="shipmate-code">Code: {m.user_code}</div>
                  </div>

                  <div className="shipmate-right">
                    <span className={pairClass(pair)}>{pair}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <style jsx>{`
        /* MUテイストに寄せた、淡い枠＆影・角丸・間隔 */
        .mu-section-title {
          margin: 0 0 8px;
          font-size: 14px;
          opacity: 0.9;
        }
        .mu-muted {
          color: #6b7280;
          font-size: 13px;
        }

        .summary-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
        }
        .summary-card {
          background: rgba(255, 255, 255, 0.8);
          border: 1px solid rgba(120, 120, 180, 0.14);
          border-radius: 12px;
          padding: 10px 12px;
          text-align: center;
          box-shadow: 0 8px 22px rgba(90, 120, 255, 0.08);
          backdrop-filter: blur(6px);
        }
        .summary-num {
          font-size: 20px;
          font-weight: 800;
          margin-top: 6px;
        }

        .shipmates-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: grid;
          gap: 8px;
        }
        .shipmate-item {
          display: grid;
          grid-template-columns: auto 1fr auto;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          background: rgba(255, 255, 255, 0.85);
          border: 1px solid rgba(120, 120, 180, 0.14);
          border-radius: 12px;
          box-shadow: 0 10px 24px rgba(90, 120, 255, 0.08);
          backdrop-filter: blur(6px);
        }
        .shipmate-left {
          display: flex;
          align-items: center;
        }
        .shipmate-avatar {
          width: 36px;
          height: 36px;
          border-radius: 9999px;
          object-fit: cover;
        }
        .shipmate-avatar.placeholder {
          background: #f3f4f6;
        }
        .shipmate-center {
          display: grid;
          gap: 2px;
        }
        .shipmate-name {
          font-weight: 600;
          line-height: 1.2;
        }
        .shipmate-code {
          font-size: 12px;
          color: #6b7280;
        }

        .pair-badge {
          display: inline-block;
          min-width: 38px;
          text-align: center;
          font-weight: 700;
          font-size: 12px;
          padding: 4px 8px;
          border-radius: 9999px;
          letter-spacing: 0.5px;
          border: 1px solid transparent;
        }
        .pair-badge.ff {
          background: #ecfdf5;
          color: #065f46;
          border-color: #a7f3d0;
        }
        .pair-badge.fr {
          background: #eff6ff;
          color: #1e40af;
          border-color: #bfdbfe;
        }
        .pair-badge.rr {
          background: #fef3c7;
          color: #92400e;
          border-color: #fde68a;
        }
        .pair-badge.other {
          background: #f3f4f6;
          color: #374151;
          border-color: #e5e7eb;
        }

        @media (max-width: 540px) {
          .summary-grid {
            grid-template-columns: 1fr 1fr;
          }
        }
      `}</style>
    </div>
  );
}
