// src/lib/getIdToken.ts
import { getAuth } from 'firebase/auth';
export default async function getIdToken() {
  const auth = getAuth();
  const u = auth.currentUser;
  if (!u) throw new Error('not signed in');
  return await u.getIdToken(true);
}
