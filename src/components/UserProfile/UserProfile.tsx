'use client';

import './ProfileBox.css';
import ProfileBasic from './ProfileBasic';
import ProfileSNS from './ProfileSNS';
import ProfileSkills from './ProfileSkills';
import ProfileActivity from './ProfileActivity';
import ProfileFriends from './ProfileFriends';
import ProfileShared from './ProfileShared';

/** 最低限の型（子は不足分を安全に扱う想定） */
export type Profile = {
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

type ProfileProps = { profile: Profile };

export default function UserProfile({ profile }: ProfileProps) {
  return (
    <div className="profile-container">
      {/* 1つのグリッドに全カードを並べる（PCで列数が増える） */}
      <div className="profile-grid-outer">
        <section className="profile-card"><ProfileBasic profile={profile} /></section>
        <section className="profile-card"><ProfileSNS profile={profile} /></section>
        <section className="profile-card"><ProfileSkills profile={profile} /></section>
        <section className="profile-card"><ProfileActivity profile={profile} /></section>
        <section className="profile-card"><ProfileFriends profile={profile} /></section>
        <section className="profile-card"><ProfileShared profile={profile} /></section>
      </div>
    </div>
  );
}
