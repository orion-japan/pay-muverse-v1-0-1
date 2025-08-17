import type { Profile } from './UserProfile';

type Props = { profile: Profile };

/**
 * friends の想定形：
 * - 未定義 or [] でもOK
 * - [{ name: string; avatar_url?: string; code?: string }] など何でも許容
 * 将来のテーブル定義に合わせやすいよう any で安全に扱う
 */
export default function ProfileFriends({ profile }: Props) {
  const friends: any[] = Array.isArray((profile as any)?.friends) ? (profile as any).friends : [];

  return (
    <section className="profile-section">
      <div className="profile-card">
        <header className="card-header">
          <h2 className="card-title">フレンド</h2>
        </header>

        {friends.length === 0 ? (
          <div className="empty">フレンド情報はまだありません</div>
        ) : (
          <ul className="friend-list">
            {friends.map((f, i) => (
              <li key={i} className="friend-item">
                {f?.avatar_url ? (
                  <img className="avatar-sm" src={f.avatar_url} alt={f?.name || 'friend'} />
                ) : (
                  <div className="avatar-sm avatar-fallback-sm" />
                )}
                <div className="friend-meta">
                  <div className="friend-name">{f?.name || 'NoName'}</div>
                  {f?.code ? <div className="muted">{f.code}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
