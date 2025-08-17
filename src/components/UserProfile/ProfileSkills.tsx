import type { Profile } from './UserProfile';

type Props = { profile: Profile };

const toArray = (v?: string[] | string | null) =>
  Array.isArray(v)
    ? v
    : (typeof v === 'string'
        ? v.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean)
        : []);

export default function ProfileSkills({ profile }: Props) {
  const skills = toArray(profile.skills);
  const interests = toArray(profile.interests);

  return (
    <section className="profile-section">
      <div className="profile-card">
        <header className="card-header">
          <h2 className="card-title">スキル・興味</h2>
        </header>

        <div className="pill-group">
          <div className="pill-title">スキル</div>
          <div className="pill-wrap">
            {skills.length ? skills.map((s, i) => <span className="pill" key={i}>#{s}</span>) : <span className="muted">—</span>}
          </div>
        </div>

        <div className="pill-group">
          <div className="pill-title">興味</div>
          <div className="pill-wrap">
            {interests.length ? interests.map((s, i) => <span className="pill" key={i}>#{s}</span>) : <span className="muted">—</span>}
          </div>
        </div>
      </div>
    </section>
  );
}
