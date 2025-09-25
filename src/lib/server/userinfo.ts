import 'server-only';
import { supabaseAdmin } from './supabaseAdmin';
import { adminAuth } from '@/lib/firebase-admin';

export type NormalizedUserInfo = {
  id: string;
  name: string;
  user_type: string;
  sofia_credit: number;
  avatar_url: string | null;
  role?: string | null;
  plan_status?: string | null;
  is_admin?: boolean;
  is_master?: boolean;
};

const toLower = (v: any) => String(v ?? '').toLowerCase();
const truthy  = (v: any) => v === true || v === 1 || v === '1' || v === 'true';

export async function resolveUserCode(input: { user_code?: string | null; idToken?: string | null }): Promise<string> {
  const { user_code, idToken } = input;
  if (user_code) return user_code;
  if (!idToken) throw new Error('user_code or idToken required');

  const decoded = await adminAuth.verifyIdToken(idToken, true);
  const firebase_uid = decoded.uid;

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('user_code')
    .eq('firebase_uid', firebase_uid)
    .maybeSingle();

  if (error) throw error;
  if (!data?.user_code) throw new Error('USER_NOT_FOUND');
  return data.user_code;
}

export async function getUserInfo(input: { user_code?: string | null; idToken?: string | null }): Promise<NormalizedUserInfo> {
  const user_code = await resolveUserCode(input);

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('user_code', user_code)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('USER_NOT_FOUND');

  const role        = toLower(data.role ?? data.user_role);
  const click_type  = toLower(data.click_type ?? (data as any).clickType);
  const plan_status = toLower(data.plan_status ?? data.plan ?? (data as any).planStatus);

  const user_type = click_type || role || plan_status || 'member';
  const is_admin  = truthy(data.is_admin)  || user_type === 'admin';
  const is_master = truthy(data.is_master) || user_type === 'master';
  const sofia_credit = Number(data.sofia_credit ?? 0);

  return {
    id: data.user_code ?? user_code,
    name: data.click_username ?? 'user',
    user_type,
    sofia_credit,
    avatar_url: (data as any).avatar_url ?? null,
    role,
    plan_status,
    is_admin,
    is_master,
  };
}
