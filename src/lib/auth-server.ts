import { createClient } from '@supabase/supabase-js';
import { adminAuth } from '@/lib/firebase-admin';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
export const sb = createClient(url, key, { auth: { persistSession: false } });

export async function identifyUserFromIdToken(req: Request) {
  const auth = req.headers.get('authorization') || '';
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!idToken) throw new Error('missing_id_token');

  const decoded = await adminAuth.verifyIdToken(idToken, true); // 署名検証
  const firebase_uid = decoded.uid as string;
  const emailFromToken = (decoded.email as string) || null;

  // uid → users を引く（email フォールバックも許可）
  let user_code: string | null = null;
  let click_email: string | null = null;
  let payjp_customer_id: string | null = null;

  // 1) uid
  const a = await sb
    .from('users')
    .select('user_code, click_email, email, payjp_customer_id')
    .eq('firebase_uid', firebase_uid)
    .maybeSingle();
  if (a.data) {
    user_code = a.data.user_code;
    click_email = a.data.click_email || a.data.email || emailFromToken;
    payjp_customer_id = a.data.payjp_customer_id;
  }

  // 2) uid で見つからず email があれば email
  if (!user_code && emailFromToken) {
    const b = await sb
      .from('users')
      .select('user_code, click_email, email, payjp_customer_id, firebase_uid')
      .or(`click_email.eq.${emailFromToken},email.eq.${emailFromToken}`)
      .maybeSingle();
    if (b.data) {
      user_code = b.data.user_code;
      click_email = b.data.click_email || b.data.email || emailFromToken;
      payjp_customer_id = b.data.payjp_customer_id;
      if (!b.data.firebase_uid) {
        await sb.from('users').update({ firebase_uid }).eq('user_code', b.data.user_code);
      }
    }
  }

  if (!user_code) throw new Error('user_not_found');
  if (!click_email) throw new Error('email_not_found');

  return { user_code, click_email, payjp_customer_id };
}
