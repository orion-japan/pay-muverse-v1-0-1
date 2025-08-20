'use client';

import './ProfileBox.css';
import ProfileBasic from './ProfileBasic';
import ProfileSNS from './ProfileSNS';
import ProfileSkills from './ProfileSkills';
import ProfileActivity from './ProfileActivity';
import ProfileFriends from './ProfileFriends';
import ProfileShared from './ProfileShared';
import ShipButton from '../ShipButton';
import MyReactionsCard from "./MyReactionsCard";

// プロフィール型
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

// Props 型
type ProfileProps = {
  profile: Profile;
  myCode?: string | null;
  isMyPage?: boolean;
  planStatus?: 'free' | 'regular' | 'premium' | 'master' | 'admin';
  onOpenTalk?: () => void;
};

export default function UserProfile({
  profile,
  myCode,
  isMyPage = false,
  planStatus = 'free',
  onOpenTalk,
}: ProfileProps) {
  const targetUserCode = profile.user_code;

  return (
    <div className="profile-container">
      <div className="profile-grid-outer">
        <section className="profile-card"><ProfileBasic profile={profile} /></section>
        <section className="profile-card"><ProfileSNS profile={profile} /></section>
        <section className="profile-card"><ProfileSkills profile={profile} /></section>
        <section className="profile-card"><ProfileActivity profile={profile} /></section>
        <section className="profile-card"><ProfileFriends profile={profile} /></section>
        <section className="profile-card"><ProfileShared profile={profile} /></section>

        {/* ✅ イイネ群カード */}
        <section className="profile-card">
          <h2 className="profile-section-title">リアクション集計</h2>
          <MyReactionsCard userCode={targetUserCode} />
        </section>

        {/* ✅ シップ制度 */}
        <section className="profile-card">
          <h2 className="profile-section-title" style={{ marginTop: 0, marginBottom: 8 }}>
            シップ（S/F/R/C/I）
          </h2>
          <ShipButton
            selfUserCode={myCode ?? ''}
            targetUserCode={targetUserCode}
            planStatus={planStatus}
            onOpenTalk={onOpenTalk}
          />
        </section>
      </div>
    </div>
  );
}
