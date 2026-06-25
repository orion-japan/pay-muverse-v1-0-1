import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { adminAuth } from '@/lib/firebase-admin';
import { supabaseAdmin as supabaseServer } from '@/lib/supabaseAdmin';
import {
  canAccessMoodleTarget,
  findMoodleTarget,
  getUserPlan,
  getUserType,
  type MoodleUserAccessRecord,
} from '@/lib/moodleAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type IssueBody = {
  target_key?: string;
};

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

async function getBearer(req: NextRequest): Promise<string | null> {
  const h = req.headers.get('authorization') || req.headers.get('Authorization');
  if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return null;
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function readTargetKey(req: NextRequest): Promise<string> {
  if (req.method === 'GET') {
    return req.nextUrl.searchParams.get('target_key')?.trim() || 'mu_book_1';
  }

  const body = (await req.json().catch(() => ({}))) as IssueBody;
  return typeof body.target_key === 'string' && body.target_key.trim()
    ? body.target_key.trim()
    : 'mu_book_1';
}

async function findMuverseUser(firebaseUid: string): Promise<{
  user: MoodleUserAccessRecord | null;
  error: string | null;
}> {
  const fullSelect = [
    'user_code',
    'click_username',
    'click_type',
    'sofia_credit',
    'plan',
    'plan_status',
    'user_type',
    'subscription_status',
    'selected_volume',
    'selected_volume_month',
    'selected_volume_locked_at',
  ].join(', ');

  const legacySelect = 'user_code, click_username, click_type, sofia_credit';

  let result = await supabaseServer
    .from('users')
    .select(fullSelect)
    .eq('firebase_uid', firebaseUid)
    .maybeSingle();

  if (result.error) {
    result = await supabaseServer
      .from('users')
      .select(legacySelect)
      .eq('firebase_uid', firebaseUid)
      .maybeSingle();
  }

  if (result.error) {
    return { user: null, error: result.error.message };
  }

  return { user: (result.data ?? null) as MoodleUserAccessRecord | null, error: null };
}

async function handle(req: NextRequest) {
  try {
    const idToken = await getBearer(req);

    if (!idToken) {
      return json(401, {
        ok: false,
        reason: 'missing_firebase_token',
        message: 'ログインが必要です。',
      });
    }

    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(idToken, true);
    } catch (e: any) {
      return json(401, {
        ok: false,
        reason: 'invalid_firebase_token',
        message: 'ログイン情報の有効期限が切れています。もう一度ログインしてください。',
        detail: e?.code || String(e),
      });
    }

    const firebase_uid = decoded.uid as string;
    const firebaseEmail = typeof decoded.email === 'string' ? decoded.email : '';
    const targetKey = await readTargetKey(req);
    const target = findMoodleTarget(targetKey);

    if (!target) {
      return json(404, {
        ok: false,
        reason: 'unknown_target',
        message: '指定された教材が見つかりません。',
        target_key: targetKey,
      });
    }

    const { user: u, error: userError } = await findMuverseUser(firebase_uid);

    if (userError) {
      return json(500, {
        ok: false,
        reason: 'db_error',
        detail: userError,
      });
    }

    if (!u?.user_code) {
      return json(404, {
        ok: false,
        reason: 'user_not_found',
        message: 'ユーザー情報が見つかりません。',
      });
    }

    const access = canAccessMoodleTarget(u, target);

    if (!access.ok) {
      return json(403, {
        ok: false,
        reason: access.reason ?? 'target_not_allowed',
        message: access.message ?? 'この教材には入場できません。',
        target_key: target.target_key,
        target_type: target.target_type,
        volume: target.volume,
        plan: getUserPlan(u),
        user_type: getUserType(u),
      });
    }

    const user_code = String(u.user_code);
    const click_username = String((u as any).click_username ?? user_code);

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const token_hash = hashToken(rawToken);
    const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const { error: insertError } = await supabaseServer
      .from('moodle_sso_tokens')
      .insert({
        token_hash,
        user_code,
        email: firebaseEmail || `${user_code}@muverse.local`,
        firstname: click_username || 'Muverse',
        lastname: 'User',
        course_id: target.course_id,
        role: access.role ?? target.role,
        redirect_path: target.redirect_path,
        target_key: target.target_key,
        target_type: target.target_type,
        expires_at: expires,
      });

    if (insertError) {
      return json(500, {
        ok: false,
        reason: 'token_insert_failed',
        detail: insertError.message,
      });
    }

    const entry_url =
      `https://e.mu-verse.jp/local/muverse_sso/entry.php?token=${encodeURIComponent(rawToken)}`;

    return json(200, {
      ok: true,
      entry_url,
      expires_at: expires,
      user_code,
      plan: getUserPlan(u),
      user_type: getUserType(u),
      target_key: target.target_key,
      target_type: target.target_type,
      course_id: target.course_id,
      role: access.role ?? target.role,
      redirect_path: target.redirect_path,
      volume: target.volume,
    });
  } catch (e: any) {
    return json(500, {
      ok: false,
      reason: 'server_error',
      detail: e?.message || String(e),
    });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
