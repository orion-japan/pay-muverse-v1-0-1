// src/app/api/agent/iros/future-seed/route.ts
// iros — future-seed route (DEPRECATED)
//
// 方針：
// - future-seed は廃止
// - route は残っていても 410 Gone を返して明示的に無効化
// - typecheck を通すため、generate / meta 参照は一切しない

export const runtime = 'nodejs';

export async function POST() {
  return new Response(
    JSON.stringify({
      ok: false,
      deprecated: true,
      message: 'future-seed is deprecated. Use /api/agent/iros/seed (or current seed route) instead.',
    }),
    {
      status: 410,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );
}

export async function GET() {
  return new Response(
    JSON.stringify({
      ok: false,
      deprecated: true,
      message: 'future-seed is deprecated.',
    }),
    {
      status: 410,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );
}
