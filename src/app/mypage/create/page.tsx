'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/firebase';
import './MyPageCreate.css';

/** 画像リサイズ（最大 maxSize px / PNG） */
function resizeImage(file: File, maxSize = 512): Promise<File> {
  return new Promise((resolve) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { if (e.target?.result) img.src = e.target.result as string; };
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }
      canvas.toBlob((blob) => {
        if (blob) resolve(new File([blob], file.name.replace(/\.\w+$/, '') + '.png', { type: 'image/png' }));
      }, 'image/png', 0.92);
    };
    reader.readAsDataURL(file);
  });
}

type MaybeArray = string[] | string | null | undefined;
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
  interests?: MaybeArray;
  skills?: MaybeArray;
  activity_area?: MaybeArray;
  languages?: MaybeArray;
  avatar_url?: string | null;
};

function emptyProfile(user_code: string): Profile {
  return {
    user_code,
    name: '',
    birthday: '',
    prefecture: '',
    city: '',
    x_handle: '',
    instagram: '',
    facebook: '',
    linkedin: '',
    youtube: '',
    website_url: '',
    interests: '',
    skills: '',
    activity_area: '',
    languages: '',
    avatar_url: null,
  };
}

export default function MyPageCreate() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [avatarUrl, setAvatarUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    (async () => {
      try {
        const user = auth.currentUser;
        if (!user) { router.push('/'); return; }
        const idToken = await user.getIdToken(true);

        // user_code
        const resStatus = await fetch('/api/account-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({}),
        });
        if (!resStatus.ok) throw new Error('account-status failed');
        const user_code = (await resStatus.json())?.user_code as string;
        if (!user_code) throw new Error('No user_code');

        // 既存プロフィール（404は未登録としてOK）
        let loaded: any = null;
        try {
          const resProf = await fetch(`/api/get-profile?code=${encodeURIComponent(user_code)}`);
          if (resProf.ok) loaded = await resProf.json();
        } catch {}
        const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
        const key = loaded?.avatar_url as string | null | undefined;
        if (key) {
          setAvatarUrl(/^https?:\/\//i.test(key) ? key : `${base}/storage/v1/object/public/avatars/${key}`);
        }

        const toDisplay = (v: MaybeArray) => (Array.isArray(v) ? v.join('、') : (v ?? ''));
        setProfile(
          loaded
            ? {
                ...loaded,
                user_code,
                interests: toDisplay(loaded.interests),
                skills: toDisplay(loaded.skills),
                activity_area: toDisplay(loaded.activity_area),
                languages: toDisplay(loaded.languages),
              }
            : emptyProfile(user_code)
        );
      } catch (e) {
        console.error('[init create] error', e);
        router.push('/');
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const resized = await resizeImage(file, 512);
      const user = auth.currentUser;
      if (!user) throw new Error('未認証');
      const idToken = await user.getIdToken(true);

      const fd = new FormData();
      fd.append('file', resized, resized.name);
      fd.append('idToken', idToken);
      fd.append('uid', user.uid);

      const res = await fetch('/api/upload-avatar', { method: 'POST', body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) throw new Error('upload failed');

      setAvatarUrl(json.publicUrl || '');
      setProfile((prev) => (prev ? { ...prev, avatar_url: json.filePath } : prev));
    } catch (err) {
      console.error('[avatar upload] error', err);
      alert('画像のアップロードに失敗しました');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('未認証');
      const idToken = await user.getIdToken(true);

      const toArray = (v: MaybeArray) =>
        typeof v === 'string'
          ? v.split(/[、,]+/).map((s) => s.trim()).filter(Boolean)
          : Array.isArray(v)
          ? v
          : [];

      const payload = {
        ...profile,
        interests: toArray(profile.interests),
        skills: toArray(profile.skills),
        activity_area: toArray(profile.activity_area),
        languages: toArray(profile.languages),
      };

      const res = await fetch('/api/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error('保存失敗');
      alert('プロフィールを更新しました');
      router.push('/mypage');
    } catch (err) {
      console.error('[save] error', err);
      alert('保存に失敗しました');
    }
  };

  if (loading) return <div className="mpc-loading">読み込み中...</div>;
  if (!profile) return <div className="mpc-loading">プロフィールが取得できませんでした</div>;

  return (
    <div className="mpc-bg">
      <form className="mpc-wrap" onSubmit={handleSubmit}>
        <div className="mpc-head">
          <h2>マイページ修正</h2>
          <p className="mpc-caption">※ 画像は自動で最大512pxに縮小して保存されます</p>
        </div>

        <div className="mpc-hero">
          <div className="mpc-avatar">
            {avatarUrl ? (
              <img src={avatarUrl} alt="avatar" />
            ) : (
              <div className="mpc-avatar-ph">No Image</div>
            )}
          </div>
          <label className="mpc-file">
            <input type="file" accept="image/*" onChange={handleAvatarUpload} />
            画像を選択
          </label>
        </div>

        <div className="mpc-grid">
          <label className="mpc-field">
            <span>ユーザーコード</span>
            <input value={profile.user_code} readOnly />
          </label>

          <label className="mpc-field">
            <span>ニックネーム</span>
            <input value={profile.name || ''} onChange={(e) => setProfile({ ...profile!, name: e.target.value })} />
          </label>

          <label className="mpc-field">
            <span>誕生日 (YYYY-MM-DD)</span>
            <input value={profile.birthday || ''} onChange={(e) => setProfile({ ...profile!, birthday: e.target.value })} />
          </label>

          <label className="mpc-field">
            <span>都道府県</span>
            <input value={profile.prefecture || ''} onChange={(e) => setProfile({ ...profile!, prefecture: e.target.value })} />
          </label>

          <label className="mpc-field">
            <span>市区町村</span>
            <input value={profile.city || ''} onChange={(e) => setProfile({ ...profile!, city: e.target.value })} />
          </label>

          <label className="mpc-field">
            <span>X (Twitter)</span>
            <input value={profile.x_handle || ''} onChange={(e) => setProfile({ ...profile!, x_handle: e.target.value })} />
          </label>

          <label className="mpc-field">
            <span>Instagram</span>
            <input value={profile.instagram || ''} onChange={(e) => setProfile({ ...profile!, instagram: e.target.value })} />
          </label>

          <label className="mpc-field">
            <span>Facebook</span>
            <input value={profile.facebook || ''} onChange={(e) => setProfile({ ...profile!, facebook: e.target.value })} />
          </label>

          <label className="mpc-field">
            <span>LinkedIn</span>
            <input value={profile.linkedin || ''} onChange={(e) => setProfile({ ...profile!, linkedin: e.target.value })} />
          </label>

          <label className="mpc-field">
            <span>YouTube</span>
            <input value={profile.youtube || ''} onChange={(e) => setProfile({ ...profile!, youtube: e.target.value })} />
          </label>

          <label className="mpc-field">
            <span>Webサイト</span>
            <input value={profile.website_url || ''} onChange={(e) => setProfile({ ...profile!, website_url: e.target.value })} />
          </label>

          <label className="mpc-field">
            <span>興味（カンマ / 読点）</span>
            <input
              value={typeof profile.interests === 'string' ? profile.interests : (profile.interests || []).join('、')}
              onChange={(e) => setProfile({ ...profile!, interests: e.target.value })}
            />
          </label>

          <label className="mpc-field">
            <span>スキル（カンマ / 読点）</span>
            <input
              value={typeof profile.skills === 'string' ? profile.skills : (profile.skills || []).join('、')}
              onChange={(e) => setProfile({ ...profile!, skills: e.target.value })}
            />
          </label>

          <label className="mpc-field">
            <span>活動地域（カンマ / 読点）</span>
            <input
              value={typeof profile.activity_area === 'string' ? profile.activity_area : (profile.activity_area || []).join('、')}
              onChange={(e) => setProfile({ ...profile!, activity_area: e.target.value })}
            />
          </label>

          <label className="mpc-field">
            <span>対応言語（カンマ / 読点）</span>
            <input
              value={typeof profile.languages === 'string' ? profile.languages : (profile.languages || []).join('、')}
              onChange={(e) => setProfile({ ...profile!, languages: e.target.value })}
            />
          </label>
        </div>

        <div className="mpc-actions">
          <button type="submit" className="mpc-save">修正を保存</button>
          <a href="/mypage" className="mpc-cancel">キャンセル</a>
        </div>
      </form>
    </div>
  );
}
