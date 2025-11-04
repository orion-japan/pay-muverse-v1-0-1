import { auth } from '@/lib/firebase';
import { getIdToken } from 'firebase/auth';

export async function redirectToMuAi() {
  const user = auth.currentUser;
  if (!user) {
    console.error('未ログインのためMu_AIに遷移できません');
    return;
  }

  try {
    const token = await getIdToken(user, true);
    window.location.href = `https://mu-ui-v1-0-5.vercel.app/auto-login?token=${token}`;
  } catch (error) {
    console.error('IDトークン取得失敗', error);
  }
}
