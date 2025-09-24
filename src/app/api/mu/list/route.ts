// src/app/api/mu/list/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 新実装を再利用（相対パスに注意）
import { GET as _GET } from '../../agent/muai/conversations/route';

export const GET = _GET;
