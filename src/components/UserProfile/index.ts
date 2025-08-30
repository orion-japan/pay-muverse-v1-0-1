// src/components/UserProfile/index.ts

// すべてここ経由で型を import できるようにする
export type { Profile, ResonanceLog, ProfileVisibility } from './types';

// 既存のコンポーネント再エクスポート（必要に応じて）
export { default as UserProfile } from './UserProfile';
export { default } from './UserProfile';
