'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/firebase';

type Profile = {
  user_code: string;
  name?: string;            // ニックネーム
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
  activity_area?: string | string[];
  languages?: string[] | string;
  avatar_url?: string | null;
};

export default function MyPageCreate() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  // 初期取得（Firebase → user_code → プロフィール）
  useEffect(() => {
    (async () => {
      try {
        const user = auth.currentUser;
        if (!user) {
          console.warn('[auth] 未ログイン → /login');
          router.push('/login');
          return;
        }
        const idToken = await user.getIdToken(true);

        // MU側で user_code を取得
        const resUser = await fetch('/api/get-current-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        });
        if (!resUser.ok) throw new Error('get-current-user失敗');
        const { user_code } = await resUser.json();

        // プロフィール取得（既存APIをそのまま利用）
        const resProf = await fetch(`/api/get-profile?code=${user_code}`);
        if (!resProf.ok) throw new Error('get-profile失敗');
        const prof = await resProf.json();

        const p: Profile = { ...prof, user_code };

        // 表示用 avatar 公開URL（バケットが public 前提）
        if (p.avatar_url) {
          const urlBase = process.env.NEXT_PUBLIC_SUPABASE_URL;
          setAvatarUrl(`${urlBase}/storage/v1/object/public/avatars/${p.avatar_url}`);
        } else {
          setAvatarUrl('');
        }

        // text[] を表示用にカンマ区切りへ（編集しやすいように）
        const normalize = (v: any) =>
          Array.isArray(v) ? v.join('、') : (v ?? '');

        setProfile({
          ...p,
          interests: normalize(p.interests),
          skills: normalize(p.skills),
          languages: normalize(p.languages),
          activity_area: normalize(p.activity_area),
        });
      } catch (e) {
        console.error('[init] 失敗', e);
        router.push('/login');
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  // 画像アップロード（→ サーバーAPIでService Roleアップロード）
  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      alert('ファイルが選択されていません');
      return;
    }
  
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('未認証');
  
      const idToken = await user.getIdToken(true);
  
      const form = new FormData();
      // 第3引数に filename を指定すると API 側で確実に file として扱われます
      form.append('file', file, file.name);
      form.append('idToken', idToken);   // Firebase Admin 用
      form.append('uid', user.uid);      // 互換用に uid も送信
  
      const res = await fetch('/api/upload-avatar', { method: 'POST', body: form });
      const json = await res.json();
  
      if (!res.ok || !json.success) {
        console.error('[Avatar Upload] ❌', json);
        alert(`アップロード失敗: ${json?.error || 'Unknown error'}`);
        return;
      }
  
      // 表示更新
      setAvatarUrl(json.publicUrl);
      setProfile(prev => prev ? { ...prev, avatar_url: json.filePath } : prev);
      console.log('[Avatar Upload] ✅ 成功', json);
    } catch (err: any) {
      console.error('[Avatar Upload] 例外', err?.message || err);
      alert('アップロード中にエラーが発生しました');
    }
  };
  

  // プロフィール保存（配列項目はカンマ/読点区切り→配列化）
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;

    try {
      const user = auth.currentUser;
      if (!user) throw new Error('未認証');
      const idToken = await user.getIdToken(true);

      const toArray = (v: any) =>
        (typeof v === 'string'
          ? v.split(/[、,]+/).map(s => s.trim()).filter(Boolean)
          : Array.isArray(v) ? v : []);

      const payload = {
        ...profile,
        // 文字列→配列へ
        interests: toArray(profile.interests),
        skills: toArray(profile.skills),
        languages: toArray(profile.languages),
        activity_area: toArray(profile.activity_area),
      };

      // 既存の update-profile API があるならそれを使う／なければ共通のupsert APIに切替えてください
      const res = await fetch('/api/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        console.error('[Profile Save] ❌', json);
        alert(`保存失敗: ${json?.error || 'Unknown error'}`);
        return;
      }

      alert('プロフィールを更新しました');
      router.push('/mypage');
    } catch (err: any) {
      console.error('[Profile Save] 例外', err?.message || err);
      alert('保存中にエラーが発生しました');
    }
  };

  if (loading) return <div>読み込み中...</div>;
  if (!profile) return <div>プロフィールが見つかりません</div>;

  return (
    <div className="mypage-container">
      <h2>マイページ修正</h2>

      {/* アバター */}
      <div style={{ marginBottom: 12 }}>
        {avatarUrl ? (
          <img src={avatarUrl} alt="avatar" width={100} height={100} style={{ borderRadius: 8 }} />
        ) : (
          <div style={{
            width: 100, height: 100, borderRadius: 8,
            background: '#eee', display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>No Image</div>
        )}
        <div style={{ marginTop: 8 }}>
          <input type="file" accept="image/*" onChange={handleAvatarUpload} />
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        {/* 変更不可 */}
        <input value={profile.user_code} readOnly placeholder="ユーザーコード" />

        {/* ニックネーム */}
        <input
          value={profile.name || ''}
          onChange={(e) => setProfile({ ...profile, name: e.target.value })}
          placeholder="ユーザーネーム（ニックネーム）"
        />

        <input
          value={profile.birthday || ''}
          onChange={(e) => setProfile({ ...profile, birthday: e.target.value })}
          placeholder="誕生日"
        />
        <input
          value={profile.prefecture || ''}
          onChange={(e) => setProfile({ ...profile, prefecture: e.target.value })}
          placeholder="都道府県"
        />
        <input
          value={profile.city || ''}
          onChange={(e) => setProfile({ ...profile, city: e.target.value })}
          placeholder="市区町村"
        />
        <input
          value={profile.x_handle || ''}
          onChange={(e) => setProfile({ ...profile, x_handle: e.target.value })}
          placeholder="X (Twitter)"
        />
        <input
          value={profile.instagram || ''}
          onChange={(e) => setProfile({ ...profile, instagram: e.target.value })}
          placeholder="Instagram"
        />
        <input
          value={profile.facebook || ''}
          onChange={(e) => setProfile({ ...profile, facebook: e.target.value })}
          placeholder="Facebook"
        />
        <input
          value={profile.linkedin || ''}
          onChange={(e) => setProfile({ ...profile, linkedin: e.target.value })}
          placeholder="LinkedIn"
        />
        <input
          value={profile.youtube || ''}
          onChange={(e) => setProfile({ ...profile, youtube: e.target.value })}
          placeholder="YouTube"
        />
        <input
          value={profile.website_url || ''}
          onChange={(e) => setProfile({ ...profile, website_url: e.target.value })}
          placeholder="Webサイト"
        />

        {/* 配列項目：カンマ/読点区切りで入力 → 保存時に配列化 */}
        <input
          value={typeof profile.interests === 'string' ? profile.interests : (profile.interests || []).join('、')}
          onChange={(e) => setProfile({ ...profile, interests: e.target.value })}
          placeholder="興味（カンマ or 読点区切り）"
        />
        <input
          value={typeof profile.skills === 'string' ? profile.skills : (profile.skills || []).join('、')}
          onChange={(e) => setProfile({ ...profile, skills: e.target.value })}
          placeholder="スキル（カンマ or 読点区切り）"
        />
        <input
          value={typeof profile.activity_area === 'string' ? profile.activity_area : (profile.activity_area || []).join('、')}
          onChange={(e) => setProfile({ ...profile, activity_area: e.target.value })}
          placeholder="活動地域（カンマ or 読点区切り）"
        />
        <input
          value={typeof profile.languages === 'string' ? profile.languages : (profile.languages || []).join('、')}
          onChange={(e) => setProfile({ ...profile, languages: e.target.value })}
          placeholder="対応言語（カンマ or 読点区切り）"
        />

        <button type="submit">修正を保存</button>
      </form>
    </div>
  );
}
