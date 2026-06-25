import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { adminAuth } from '@/lib/firebase-admin';
import { supabaseAdmin as supabaseServer } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type IssueBody = {
  target_key?: string;
};

type MoodleTarget = {
  target_key: string;
  target_type: 'course' | 'book' | 'quiz' | 'assignment';
  course_id: number;
  role: 'student' | 'teacher' | 'editingteacher';
  redirect_path: string;
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

function resolveMoodleTarget(targetKey: string, clickType: string): MoodleTarget | null {
  const key = targetKey || 'mu_book_1';

  const targets: Record<string, MoodleTarget> = {
    mu_book_1: {
      target_key: 'mu_book_1',
      target_type: 'book',
      course_id: 2,
      role: 'student',
      redirect_path: '/mod/book/view.php?id=2',
    },

    mu_course_1: {
      target_key: 'mu_course_1',
      target_type: 'course',
      course_id: 2,
      role: 'student',
      redirect_path: '/course/view.php?id=2',
    },
  };

  const target = targets[key];
  if (!target) return null;

  // Phase 4.1:
  // まずは全ログインユーザーに course_id=2 を許可。
  // 次に regular / premium / master ごとの制御へ広げる。
  const allowedForNow = ['free', 'regular', 'premium', 'master', 'teacher', 'admin'];

  if (!allowedForNow.includes(clickType)) {
    return null;
  }

  return target;
}

export async function POST(req: NextRequest) {
  try {
    const idToken = await getBearer(req);

    if (!idToken) {
      return json(401, {
        ok: false,
        reason: 'missing_firebase_token',
      });
    }

    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(idToken, true);
    } catch (e: any) {
      return json(401, {
        ok: false,
        reason: 'invalid_firebase_token',
        detail: e?.code || String(e),
      });
    }

    const firebase_uid = decoded.uid as string;
    const firebaseEmail = typeof decoded.email === 'string' ? decoded.email : '';

    const body = (await req.json().catch(() => ({}))) as IssueBody;
    const targetKey = typeof body.target_key === 'string' ? body.target_key.trim() : 'mu_book_1';

    const { data: u, error: e1 } = await supabaseServer
      .from('users')
      .select('user_code, click_username, click_type, sofia_credit')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle();

    if (e1) {
      return json(500, {
        ok: false,
        reason: 'db_error',
        detail: e1.message,
      });
    }

    if (!u?.user_code) {
      return json(404, {
        ok: false,
        reason: 'user_not_found',
      });
    }

    const user_code = String(u.user_code);
    const click_username = String((u as any).click_username ?? user_code);
    const click_type = String((u as any).click_type ?? 'free');

    const target = resolveMoodleTarget(targetKey, click_type);

    if (!target) {
      return json(403, {
        ok: false,
        reason: 'target_not_allowed',
        target_key: targetKey,
      });
    }

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
        role: target.role,
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
      click_type,
      target_key: target.target_key,
      target_type: target.target_type,
      course_id: target.course_id,
      role: target.role,
      redirect_path: target.redirect_path,
    });
  } catch (e: any) {
    return json(500, {
      ok: false,
      reason: 'server_error',
      detail: e?.message || String(e),
    });
  }
}
