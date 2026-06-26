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

  section_index?: number | string | null;
  total_sections?: number | string | null;
  progress_percent?: number | string | null;

  completed_section_index?: number | string | null;
  completed_progress_percent?: number | string | null;

  scroll_y?: number | string | null;
  text?: string | null;
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

const bookmarkSelectFields = [
  'user_code',
  'target_key',
  'course_id',
  'chapter_id',
  'chapter_title',
  'position_index',
  'paragraph_index',
  'char_offset',
  'audio_time',
  'mode',
  'source',
  'updated_from',
  'section_index',
  'total_sections',
  'progress_percent',
  'completed_section_index',
  'completed_progress_percent',
  'scroll_y',
  'text',
  'updated_at',
].join(', ');

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

function toNullablePercent(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function calculateProgressPercent(sectionIndex: number | null, totalSections: number | null) {
  if (sectionIndex === null || totalSections === null || totalSections <= 0) return null;
  return Math.max(0, Math.min(100, (sectionIndex / totalSections) * 100));
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
      .select(bookmarkSelectFields)
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

    const incomingSectionIndex = toNullableInt(body.section_index);
    const incomingTotalSections = toNullableInt(body.total_sections);
    const incomingProgressPercent =
      toNullablePercent(body.progress_percent) ??
      calculateProgressPercent(incomingSectionIndex, incomingTotalSections);

    const { data: existingBookmark, error: existingBookmarkError } = await supabaseServer
      .from('moodle_bookmarks')
      .select('completed_section_index, completed_progress_percent, total_sections')
      .eq('user_code', auth.user_code)
      .eq('target_key', target_key)
      .maybeSingle();

    if (existingBookmarkError) {
      return json(500, { ok: false, reason: 'db_error', detail: existingBookmarkError.message });
    }

    const existingCompletedSectionIndex = toInt(existingBookmark?.completed_section_index, 0);
    const existingCompletedProgressPercent =
      toNullablePercent(existingBookmark?.completed_progress_percent) ?? 0;
    const existingTotalSections = toNullableInt(existingBookmark?.total_sections);

    const isSequentialProgress =
      incomingSectionIndex !== null &&
      (
        existingCompletedSectionIndex <= 0
          ? incomingSectionIndex <= 1
          : incomingSectionIndex <= existingCompletedSectionIndex + 1
      );

    const nextCompletedSectionIndex =
      isSequentialProgress && incomingSectionIndex !== null
        ? Math.max(existingCompletedSectionIndex, incomingSectionIndex)
        : existingCompletedSectionIndex;

    const effectiveTotalSections = incomingTotalSections ?? existingTotalSections;

    const calculatedCompletedProgressPercent =
      calculateProgressPercent(nextCompletedSectionIndex, effectiveTotalSections);

    const nextCompletedProgressPercent =
      calculatedCompletedProgressPercent !== null
        ? Math.max(existingCompletedProgressPercent, calculatedCompletedProgressPercent)
        : existingCompletedProgressPercent;

    const baseUpdatedFrom = cleanText(body.updated_from, auth.by) || auth.by;
    const finalUpdatedFrom =
      incomingSectionIndex === null || isSequentialProgress
        ? baseUpdatedFrom
        : 'jump_ignored:' + baseUpdatedFrom;

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
      updated_from: finalUpdatedFrom,

      section_index: incomingSectionIndex,
      total_sections: incomingTotalSections,
      progress_percent: incomingProgressPercent,

      completed_section_index: nextCompletedSectionIndex,
      completed_progress_percent: nextCompletedProgressPercent,

      scroll_y: toNullableInt(body.scroll_y),
      text: cleanText(body.text) || null,

      updated_at: now,
    };

    const { data, error } = await supabaseServer
      .from('moodle_bookmarks')
      .upsert(payload, { onConflict: 'user_code,target_key' })
      .select(bookmarkSelectFields)
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