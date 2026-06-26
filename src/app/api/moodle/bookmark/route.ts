import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { supabaseAdmin as supabaseServer } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type BookmarkBody = {
  user_code?: string;
  target_key?: string;
  course_id?: number | string | null;
  chapter_id?: string | null;
  chapter_title?: string | null;
  position_index?: number | string | null;
  paragraph_index?: number | string | null;
  char_offset?: number | string | null;
  audio_time?: number | string | null;
  mode?: string | null;
  source?: string | null;
  updated_from?: string | null;
};

type AuthContext = {
  user_code: string;
  by: 'firebase' | 'moodle_secret';
};

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://e.mu-verse.jp',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Moodle-Secret',
  'Access-Control-Max-Age': '86400',
};

function json(status: number, body: any) {
  return NextResponse.json(body, { status, headers: corsHeaders });
}

function cleanText(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function toInt(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function toNullableInt(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

function toNullableNumber(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

function isAllowedTargetKey(targetKey: string) {
  return /^mu_book_(10|[1-9])$/.test(targetKey);
}

async function getBearer(req: NextRequest): Promise<string | null> {
  const h = req.headers.get('authorization') || req.headers.get('Authorization');
  if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return null;
}

async function findUserCodeByFirebaseUid(firebaseUid: string) {
  const { data, error } = await supabaseServer
    .from('users')
    .select('user_code')
    .eq('firebase_uid', firebaseUid)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return typeof data?.user_code === 'string' ? data.user_code : '';
}

async function resolveAuthContext(req: NextRequest, requestedUserCode = ''): Promise<AuthContext | null> {
  const moodleSecret = process.env.MOODLE_BOOKMARK_SHARED_SECRET || process.env.MOODLE_SHARED_SECRET || '';
  const providedSecret = req.headers.get('x-moodle-secret') || req.headers.get('X-Moodle-Secret') || '';

  if (moodleSecret && providedSecret && providedSecret === moodleSecret) {
    const user_code = cleanText(requestedUserCode);
    if (!user_code) return null;
    return { user_code, by: 'moodle_secret' };
  }

  const idToken = await getBearer(req);
  if (!idToken) return null;

  const decoded = await adminAuth.verifyIdToken(idToken, true);
  const user_code = await findUserCodeByFirebaseUid(decoded.uid as string);
  if (!user_code) return null;

  if (requestedUserCode && requestedUserCode !== user_code) return null;
  return { user_code, by: 'firebase' };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(req: NextRequest) {
  try {
    const requestedUserCode = cleanText(req.nextUrl.searchParams.get('user_code'));
    const target_key = cleanText(req.nextUrl.searchParams.get('target_key')) || 'mu_book_1';

    if (!isAllowedTargetKey(target_key)) {
      return json(400, { ok: false, reason: 'invalid_target_key' });
    }

    const auth = await resolveAuthContext(req, requestedUserCode);
    if (!auth) {
      return json(401, { ok: false, reason: 'unauthorized' });
    }

    const { data, error } = await supabaseServer
      .from('moodle_bookmarks')
      .select(
        'user_code, target_key, course_id, chapter_id, chapter_title, position_index, paragraph_index, char_offset, audio_time, mode, source, updated_from, updated_at'
      )
      .eq('user_code', auth.user_code)
      .eq('target_key', target_key)
      .maybeSingle();

    if (error) {
      return json(500, { ok: false, reason: 'db_error', detail: error.message });
    }

    return json(200, {
      ok: true,
      found: !!data,
      bookmark: data ?? null,
    });
  } catch (e: any) {
    return json(500, { ok: false, reason: 'server_error', detail: e?.message || String(e) });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as BookmarkBody;
    const requestedUserCode = cleanText(body.user_code);
    const target_key = cleanText(body.target_key) || 'mu_book_1';

    if (!isAllowedTargetKey(target_key)) {
      return json(400, { ok: false, reason: 'invalid_target_key' });
    }

    const auth = await resolveAuthContext(req, requestedUserCode);
    if (!auth) {
      return json(401, { ok: false, reason: 'unauthorized' });
    }

    const now = new Date().toISOString();
    const payload = {
      user_code: auth.user_code,
      target_key,
      course_id: toNullableInt(body.course_id),
      chapter_id: cleanText(body.chapter_id) || null,
      chapter_title: cleanText(body.chapter_title) || null,
      position_index: toInt(body.position_index, 0),
      paragraph_index: toInt(body.paragraph_index, 0),
      char_offset: toInt(body.char_offset, 0),
      audio_time: toNullableNumber(body.audio_time),
      mode: cleanText(body.mode, 'reading') || 'reading',
      source: cleanText(body.source, 'moodle') || 'moodle',
      updated_from: cleanText(body.updated_from, auth.by) || auth.by,
      updated_at: now,
    };

    const { data, error } = await supabaseServer
      .from('moodle_bookmarks')
      .upsert(payload, { onConflict: 'user_code,target_key' })
      .select(
        'user_code, target_key, course_id, chapter_id, chapter_title, position_index, paragraph_index, char_offset, audio_time, mode, source, updated_from, updated_at'
      )
      .single();

    if (error) {
      return json(500, { ok: false, reason: 'db_error', detail: error.message });
    }

    return json(200, {
      ok: true,
      bookmark: data,
    });
  } catch (e: any) {
    return json(500, { ok: false, reason: 'server_error', detail: e?.message || String(e) });
  }
}
