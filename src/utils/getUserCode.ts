// src/utils/getUserCode.ts

export function getUserCode(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('user_code');
}
