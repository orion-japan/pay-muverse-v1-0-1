export type InviteParams = {
  origin: string; // 例: https://muverse.jp
  user_code: string; // users.user_code
  rcode?: string | null; // users.rcode
  mcode?: string | null; // users.mcode（必須化したいならクエリに必ず付ける）
  group?: string | null; // users.leader_origin など
};

export function buildInviteUrl(p: InviteParams) {
  const u = new URL('/register', p.origin); // 登録導線の実URLに合わせて
  u.searchParams.set('ref', p.user_code);
  if (p.rcode) u.searchParams.set('rcode', p.rcode);
  if (p.mcode) u.searchParams.set('mcode', p.mcode);
  if (p.group) u.searchParams.set('group', p.group);
  return u.toString();
}

/** ヘッダから origin を安全に決定（本番/プレビュー/ローカル） */
export function resolveOrigin(req: Request) {
  const h = new Headers(req.headers);
  // Vercel の場合
  const host = h.get('x-forwarded-host') || h.get('host') || 'localhost:3000';
  const proto = (h.get('x-forwarded-proto') || 'https').includes('http')
    ? h.get('x-forwarded-proto')!
    : 'https';
  const envOrigin = process.env.SITE_ORIGIN; // 任意: 環境変数で固定したい場合
  return envOrigin || `${proto}://${host}`;
}
