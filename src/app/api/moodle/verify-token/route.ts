import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin as supabaseServer } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type VerifyBody = {
  token?: string;
};

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as VerifyBody;
    const token = typeof body.token === 'string' ? body.token.trim() : '';

    if (!token) {
      return json(400, {
        ok: false,
        reason: 'missing_token',
      });
    }

    const token_hash = hashToken(token);
    const now = new Date().toISOString();

    const { data: row, error: selectError } = await supabaseServer
      .from('moodle_sso_tokens')
      .select(
        'id, user_code, email, firstname, lastname, course_id, role, redirect_path, target_key, target_type, expires_at, used_at'
      )
      .eq('token_hash', token_hash)
      .maybeSingle();

    if (selectError) {
      return json(500, {
        ok: false,
        reason: 'db_error',
        detail: selectError.message,
      });
    }

    if (!row) {
      return json(401, {
        ok: false,
        reason: 'invalid_token',
      });
    }

    if (row.used_at) {
      return json(401, {
        ok: false,
        reason: 'token_already_used',
      });
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      return json(401, {
        ok: false,
        reason: 'token_expired',
      });
    }

    const { error: updateError } = await supabaseServer
      .from('moodle_sso_tokens')
      .update({
        used_at: now,
      })
      .eq('id', row.id)
      .is('used_at', null);

    if (updateError) {
      return json(500, {
        ok: false,
        reason: 'token_update_failed',
        detail: updateError.message,
      });
    }

    return json(200, {
      ok: true,
      user_code: row.user_code,
      email: row.email,
      name: `${row.firstname} ${row.lastname}`.trim(),
      firstname: row.firstname,
      lastname: row.lastname,
      target_key: row.target_key,
      target_type: row.target_type,
      allowed_courses: [
        {
          course_id: row.course_id,
          role: row.role || 'student',
          redirect: row.redirect_path || `/course/view.php?id=${row.course_id}`,
        },
      ],
      redirect: row.redirect_path || `/course/view.php?id=${row.course_id}`,
    });
  } catch (e: any) {
    return json(500, {
      ok: false,
      reason: 'server_error',
      detail: e?.message || String(e),
    });
  }
}

export async function GET() {
  return json(405, {
    ok: false,
    reason: 'method_not_allowed',
  });
}
