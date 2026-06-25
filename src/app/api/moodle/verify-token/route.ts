import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type VerifyBody = {
  token?: string;
};

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
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

    // Phase 3 demo:
    // まず Moodle 側から Muverse API を呼べるか確認するため、demo だけ通す。
    // 本番では Supabase の one-time token テーブルを検証する。
    if (token !== 'demo') {
      return json(401, {
        ok: false,
        reason: 'invalid_token',
      });
    }

    return json(200, {
      ok: true,
      user_code: 'demo',
      email: 'demo-muverse@example.com',
      name: 'Muverse Demo',
      firstname: 'Muverse',
      lastname: 'Demo',
      allowed_courses: [
        {
          course_id: 2,
          role: 'student',
          redirect: '/mod/book/view.php?id=2',
        },
      ],
      redirect: '/mod/book/view.php?id=2',
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
