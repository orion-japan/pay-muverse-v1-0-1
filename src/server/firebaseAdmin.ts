import { adminAuth as _adminAuth } from '@/lib/firebase-admin';

export function ensureFirebaseAdmin() {
  // no-op
}
export function adminAuth() {
  ensureFirebaseAdmin();
  return _adminAuth;
}
