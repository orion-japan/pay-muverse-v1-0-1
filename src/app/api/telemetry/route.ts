import { cookies } from 'next/headers';

export async function POST(req: Request) {
  const sid = (await cookies()).get('mu_sid')?.value ?? null;
  // ← sid を session_id に入れて保存する
  return new Response(null, { status: 204 });
}
