// src/lib/avatar.ts
export function resolveAvatarUrl(u?: string | null) {
  if (!u || u.startsWith('/thread/')) return '/images/avatar_default.png';
  return u;
}
