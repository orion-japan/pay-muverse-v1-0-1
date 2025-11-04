import { getAuth } from 'firebase/auth';

const CORE_API = process.env.NEXT_PUBLIC_PAY_API_BASE!; // 例: "https://pay.muverse.jp"

export async function resolveUser() {
  const auth = getAuth();
  const idToken = await auth.currentUser?.getIdToken(true);
  if (!idToken) throw new Error('NO_ID_TOKEN');

  const res = await fetch(`${CORE_API}/api/resolve-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });

  if (res.status === 404) throw new Error('USER_NOT_FOUND');
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error || `HTTP_${res.status}`);
  }
  return res.json() as Promise<{
    ok: true;
    user_code: string;
    role: string;
    click_type: string;
    plan_status: string;
    is_admin: boolean;
    is_master: boolean;
    login_url: string;
  }>;
}
