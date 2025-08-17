import type { Profile } from './UserProfile';

type Props = { profile: Profile };

const toArray = (v?: string[] | string | null) =>
  Array.isArray(v)
    ? v
    : (typeof v === 'string'
        ? v.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean)
        : []);

export default function ProfileActivity({ profile }: Props) {
  const areas = toArray(profile.activity_area);
  const langs = toArray(profile.languages);

  return (
    <section className="profile-section">
      <div className="profile-card">
        <header className="card-header">
          <h2 className="card-title">活動地域・対応言語</h2>
        </header>

        <div className="pill-group">
          <div className="pill-title">活動地域</div>
          <div className="pill-wrap">
            {areas.length ? areas.map((s, i) => <span className="pill" key={i}>#{s}</span>) : <span className="muted">—</span>}
          </div>
        </div>

        <div className="pill-group">
          <div className="pill-title">対応言語</div>
          <div className="pill-wrap">
            {langs.length ? langs.map((s, i) => <span className="pill" key={i}>#{s}</span>) : <span className="muted">—</span>}
          </div>
        </div>
      </div>
    </section>
  );
}
