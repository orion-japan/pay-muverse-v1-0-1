// src/app/api/agent/iros/retitle/route.ts  ← 一時スタブ（安全に廃止）
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

export async function OPTIONS() {
  return NextResponse.json({ ok: false, error: 'endpoint_removed' }, { status: 410 });
}
export async function POST() {
  return NextResponse.json({ ok: false, error: 'endpoint_removed' }, { status: 410 });
}
export async function GET() {
  return NextResponse.json({ ok: false, error: 'endpoint_removed' }, { status: 410 });
}
