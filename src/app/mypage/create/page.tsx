// src/app/mypage/create/page.tsx
'use client';
import React from 'react';
import UserProfileEditor from '@/components/UserProfile/UserProfileEditor';
import '../mypage.css';

export default function MyPageCreate() {
  return (
    <div className="mypage-wrapper">
      <div className="mypage-container">
        <UserProfileEditor />
      </div>
    </div>
  );
}
