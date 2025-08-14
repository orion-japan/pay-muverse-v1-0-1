export default function MyPageEntry({ profile }) {
  return (
    <main style={{ width: '100%', display: 'block' }}>
      <div
        style={{
          maxWidth: '800px',
          margin: '40px auto',
          padding: '20px',
          backgroundColor: '#ffffff',
          border: '1px solid #ddd',
          borderRadius: '8px',
          boxShadow: '0 4px 10px rgba(0,0,0,0.1)',
          fontFamily: 'Arial, sans-serif',
          lineHeight: '1.6',
          zIndex: 9999,
          position: 'relative',
        }}
      >
        <h1
          style={{
            fontSize: '24px',
            fontWeight: 'bold',
            marginBottom: '20px',
            borderBottom: '2px solid #f0f0f0',
            paddingBottom: '10px',
          }}
        >
          マイページ
        </h1>

        <p><strong>ユーザーコード:</strong> {profile.user_code}</p>
        <p><strong>誕生日:</strong> {profile.birthday || '-'}</p>
        <p><strong>所在地:</strong> {profile.prefecture} {profile.city}</p>
        <p><strong>X:</strong> {profile.x_handle || '-'}</p>
        <p><strong>Instagram:</strong> {profile.instagram || '-'}</p>
        <p><strong>Facebook:</strong> {profile.facebook || '-'}</p>
        <p><strong>LinkedIn:</strong> {profile.linkedin || '-'}</p>
        <p><strong>YouTube:</strong> {profile.youtube || '-'}</p>
        <p><strong>Webサイト:</strong> {profile.website_url || '-'}</p>
        <p><strong>興味:</strong> {Array.isArray(profile.interests) ? profile.interests.join(', ') : profile.interests || '-'}</p>
        <p><strong>スキル:</strong> {Array.isArray(profile.skills) ? profile.skills.join(', ') : profile.skills || '-'}</p>
        <p><strong>活動地域:</strong> {Array.isArray(profile.activity_area) ? profile.activity_area.join(', ') : profile.activity_area || '-'}</p>
        <p><strong>対応言語:</strong> {Array.isArray(profile.languages) ? profile.languages.join(', ') : profile.languages || '-'}</p>
      </div>
    </main>
  );
}
