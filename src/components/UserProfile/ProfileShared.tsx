import type { Profile } from './UserProfile';

type Props = { profile: Profile };

/**
 * shared の想定形：
 * - 未定義 or [] でもOK
 * - [{ title: string; link?: string; by?: string; at?: string }] などを想定
 */
export default function ProfileShared({ profile }: Props) {
  const shared: any[] = Array.isArray((profile as any)?.shared) ? (profile as any).shared : [];

  return (
    <section className="profile-section">
      <div className="profile-card">
        <header className="card-header">
          <h2 className="card-title">シェア情報</h2>
        </header>

        {shared.length === 0 ? (
          <div className="empty">シェアされた情報はまだありません</div>
        ) : (
          <ul className="shared-list">
            {shared.map((s, i) => (
              <li key={i} className="shared-item">
                {s?.link ? (
                  <a href={s.link} className="link" target="_blank" rel="noreferrer">
                    {s?.title || s?.link}
                  </a>
                ) : (
                  <span className="mono">{s?.title || 'Untitled'}</span>
                )}
                {(s?.by || s?.at) ? (
                  <span className="muted small"> {s?.by ? `by ${s.by}` : ''} {s?.at ? ` • ${s.at}` : ''}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
