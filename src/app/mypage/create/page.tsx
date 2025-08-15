'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/firebase';

type Profile = {
  user_code: string;
  name?: string;
  birthday?: string;
  prefecture?: string;
  city?: string;
  x_handle?: string;
  instagram?: string;
  facebook?: string;
  linkedin?: string;
  youtube?: string;
  website_url?: string;
  interests?: string[] | string;
  skills?: string[] | string;
  activity_area?: string[] | string;
  languages?: string[] | string;
  avatar_url?: string | null;
};

export default function MyPageCreate() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [avatarUrl, setAvatarUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    (async () => {
      try {
        const user = auth.currentUser;
        if (!user) {
          console.warn('[auth] 未ログイン → /');
          router.push('/'); // ← 修正点：/login → /
          return;
        }
        const idToken = await user.getIdToken(true);

        const resUser = await fetch('/api/get-current-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        });
        const userJson = await resUser.json();
        const user_code = userJson?.user_code;
        if (!user_code) throw new Error('user_code取得失敗');

        const resProfile = await fetch(`/api/get-profile?code=${user_code}`);
        const prof = await resProfile.json();
        const p: Profile = { ...prof, user_code };

        const urlBase = process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (p.avatar_url) {
          setAvatarUrl(`${urlBase}/storage/v1/object/public/avatars/${p.avatar_url}`);
        }

        const normalize = (v: any) => Array.isArray(v) ? v.join('、') : (v ?? '');

        setProfile({
          ...p,
          interests: normalize(p.interests),
          skills: normalize(p.skills),
          languages: normalize(p.languages),
          activity_area: normalize(p.activity_area),
        });
      } catch (err) {
        console.error('[プロフィール取得失敗]', err);
        router.push('/'); // ← 修正点：失敗時も / に遷移
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const user = auth.currentUser;
      if (!user) throw new Error('未認証');
      const idToken = await user.getIdToken(true);

      const formData = new FormData();
      formData.append('file', file, file.name);
      formData.append('idToken', idToken);
      formData.append('uid', user.uid);

      const res = await fetch('/api/upload-avatar', {
        method: 'POST',
        body: formData,
      });
      const json = await res.json();

      if (!res.ok || !json.success) {
        console.error('[Avatar Upload] ❌', json);
        alert('アップロード失敗');
        return;
      }

      setAvatarUrl(json.publicUrl);
      setProfile(prev => prev ? { ...prev, avatar_url: json.filePath } : prev);
    } catch (err) {
      console.error('[Avatar Upload] 例外', err);
      alert('アップロード中にエラーが発生しました');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;

    try {
      const user = auth.currentUser;
      if (!user) throw new Error('未認証');
      const idToken = await user.getIdToken(true);

      const toArray = (v: any) =>
        typeof v === 'string'
          ? v.split(/[、,]+/).map((s) => s.trim()).filter(Boolean)
          : Array.isArray(v) ? v : [];

      const payload = {
        ...profile,
        interests: toArray(profile.interests),
        skills: toArray(profile.skills),
        languages: toArray(profile.languages),
        activity_area: toArray(profile.activity_area),
      };

      const res = await fetch('/api/update-profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json();

      if (!res.ok) {
        console.error('[プロフィール保存] ❌', json);
        alert('保存に失敗しました');
        return;
      }

      alert('プロフィールを更新しました');
      router.push('/mypage');
    } catch (err) {
      console.error('[プロフィール保存エラー]', err);
      alert('エラーが発生しました');
    }
  };

  if (loading) return <div>読み込み中...</div>;
  if (!profile) return <div>プロフィールが取得できませんでした</div>;

  return (
    <div className="mypage-container">
      <h2>マイページ修正</h2>

      {/* アバター */}
      <div>
        {avatarUrl ? (
          <img src={avatarUrl} alt="avatar" width={100} height={100} style={{ borderRadius: 8 }} />
        ) : (
          <div style={{ width: 100, height: 100, background: '#eee', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            No Image
          </div>
        )}
        <input type="file" accept="image/*" onChange={handleAvatarUpload} />
      </div>

      <form onSubmit={handleSubmit}>
        <input value={profile.user_code} readOnly placeholder="ユーザーコード" />
        <input value={profile.name || ''} onChange={e => setProfile({ ...profile, name: e.target.value })} placeholder="ニックネーム" />
        <input value={profile.birthday || ''} onChange={e => setProfile({ ...profile, birthday: e.target.value })} placeholder="誕生日" />
        <input value={profile.prefecture || ''} onChange={e => setProfile({ ...profile, prefecture: e.target.value })} placeholder="都道府県" />
        <input value={profile.city || ''} onChange={e => setProfile({ ...profile, city: e.target.value })} placeholder="市区町村" />
        <input value={profile.x_handle || ''} onChange={e => setProfile({ ...profile, x_handle: e.target.value })} placeholder="X (Twitter)" />
        <input value={profile.instagram || ''} onChange={e => setProfile({ ...profile, instagram: e.target.value })} placeholder="Instagram" />
        <input value={profile.facebook || ''} onChange={e => setProfile({ ...profile, facebook: e.target.value })} placeholder="Facebook" />
        <input value={profile.linkedin || ''} onChange={e => setProfile({ ...profile, linkedin: e.target.value })} placeholder="LinkedIn" />
        <input value={profile.youtube || ''} onChange={e => setProfile({ ...profile, youtube: e.target.value })} placeholder="YouTube" />
        <input value={profile.website_url || ''} onChange={e => setProfile({ ...profile, website_url: e.target.value })} placeholder="Webサイト" />
        <input value={typeof profile.interests === 'string' ? profile.interests : (profile.interests || []).join('、')} onChange={e => setProfile({ ...profile, interests: e.target.value })} placeholder="興味（カンマ or 読点）" />
        <input value={typeof profile.skills === 'string' ? profile.skills : (profile.skills || []).join('、')} onChange={e => setProfile({ ...profile, skills: e.target.value })} placeholder="スキル" />
        <input value={typeof profile.activity_area === 'string' ? profile.activity_area : (profile.activity_area || []).join('、')} onChange={e => setProfile({ ...profile, activity_area: e.target.value })} placeholder="活動地域" />
        <input value={typeof profile.languages === 'string' ? profile.languages : (profile.languages || []).join('、')} onChange={e => setProfile({ ...profile, languages: e.target.value })} placeholder="対応言語" />
        <button type="submit">修正を保存</button>
      </form>
    </div>
  );
}
