import { NextResponse } from 'next/server';

const KEY = 'MUVERSE_LIVE_STATE';
const ADMIN_TOKEN = process.env.LIVE_ADMIN_TOKEN;

function setState(s: any) {
  (globalThis as any)[KEY] = s;
}

export async function POST(req: Request) {
  if (ADMIN_TOKEN && req.headers.get('x-live-admin-token') !== ADMIN_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  setState({ is_live: false });
  return NextResponse.json({ ok: true });
}
