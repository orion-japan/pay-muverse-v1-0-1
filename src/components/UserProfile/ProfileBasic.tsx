// src/components/UserProfile/ProfileBasic.tsx
'use client';

import React, { useMemo } from 'react';
import type { Profile } from '@/components/UserProfile';
import SafeImage from '@/components/common/SafeImage';

type Props = {
  profile: Profile;
  editable?: boolean;
  onChange?: (p: Partial<Profile>) => void;
};

export default function ProfileBasic({ profile, editable, onChange }: Props) {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');

  // フルURL化（API側でも行うが、表示側でも保険を掛ける）
  const avatar = useMemo(() => {
    const v = profile?.avatar_url || '';
    if (!v) return '/img/no-avatar.svg'; // ← public/img/no-avatar.svg を用意
    if (/^https?:\/\//i.test(v)) return v;
    return `${base}/storage/v1/object/public/avatars/${v}`;
  }, [profile?.avatar_url, base]);

  const set =
    (k: keyof Profile) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange?.({ [k]: e.target.value } as Partial<Profile>);

  return (
    <div className="profile-basic">
      <div className="basic-head">
        <div className="avatar-wrap">
          <SafeImage
            src={avatar}
            alt={profile?.name ?? 'avatar'}
            aspectRatio="1/1"
            className="profile-avatar"
          />
        </div>
        <div className="name-block">
          {editable ? (
            <>
              <label className="mu-label">ニックネーム</label>
              <input
                className="mu-input"
                value={profile.name ?? ''}
                onChange={set('name')}
                placeholder="ニックネーム"
              />
            </>
          ) : (
            <h2 className="display-name">{profile.name || 'ニックネーム未設定'}</h2>
          )}
          <div className="user-code">Code: {profile.user_code}</div>
        </div>
      </div>

      {/* 以下、必要に応じて編集フィールド（肩書き/所属/専門/所在地/自己紹介 など） */}
      <div className="grid gap-3" style={{ marginTop: 12 }}>
        <div>
          <label className="mu-label">肩書き / ひとこと</label>
          <input
            className="mu-input"
            value={profile.headline ?? ''}
            onChange={set('headline')}
            placeholder="例: 共感OSのデザイナー"
            disabled={!editable}
          />
        </div>

        <div>
          <label className="mu-label">所属</label>
          <input
            className="mu-input"
            value={profile.organization ?? ''}
            onChange={set('organization')}
            placeholder="例: Muverse Inc."
            disabled={!editable}
          />
        </div>

        <div>
          <label className="mu-label">専門・役割</label>
          <input
            className="mu-input"
            value={profile.position ?? ''}
            onChange={set('position')}
            placeholder="例: Product / Engineer"
            disabled={!editable}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mu-label">都道府県</label>
            <input
              className="mu-input"
              value={profile.prefecture ?? ''}
              onChange={set('prefecture')}
              placeholder="東京都 など"
              disabled={!editable}
            />
          </div>
          <div>
            <label className="mu-label">市区町村</label>
            <input
              className="mu-input"
              value={profile.city ?? ''}
              onChange={set('city')}
              placeholder="渋谷区 など"
              disabled={!editable}
            />
          </div>
        </div>

        <div>
          <label className="mu-label">自己紹介（Bio）</label>
          <textarea
            className="mu-textarea"
            value={profile.bio ?? ''}
            onChange={set('bio')}
            placeholder="あなたの活動や興味を書いてください"
            disabled={!editable}
            rows={3}
          />
        </div>

        <div>
          <label className="mu-label">意図・何をしているか（mission）</label>
          <textarea
            className="mu-textarea"
            value={profile.mission ?? ''}
            onChange={set('mission')}
            placeholder="ミッション / 取り組み中のこと"
            disabled={!editable}
            rows={2}
          />
        </div>

        <div>
          <label className="mu-label">募集中・求めていること（looking_for）</label>
          <textarea
            className="mu-textarea"
            value={profile.looking_for ?? ''}
            onChange={set('looking_for')}
            placeholder="一緒にやりたいこと / 探しているスキルなど"
            disabled={!editable}
            rows={2}
          />
        </div>
      </div>
    </div>
  );
}
