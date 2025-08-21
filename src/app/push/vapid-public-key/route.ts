import { NextResponse } from 'next/server';

export async function GET() {
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY; // 例: envに入れておく
  if (!pub) {
    return NextResponse.json({ error: 'VAPID public key not set' }, { status: 500 });
  }
  return NextResponse.json({ key: pub });
}
