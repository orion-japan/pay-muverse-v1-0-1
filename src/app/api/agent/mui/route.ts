// src/app/api/agent/mui/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';
import { retrieveKnowledge } from '@/lib/sofia/retrieve';
import { nextQFrom } from '@/lib/mui/nextQFrom';
import { chargeIfNeeded } from '@/lib/mui/billing';

import { inferPhase as inferPhaseFn } from '@/lib/mui/inferPhase';
import { estimateSelfAcceptance as estimateSelfAcceptanceFn } from '@/lib/mui/estimateSelfAcceptance';

import { handleFormatOnly } from './handlers/formatOnly';
import { handleCoachFromText } from './handlers/coachFromText';
import { handleChat } from './handlers/chat';

// ===== OpenAI =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

// ===== Config =====
const MODEL = (process.env.OPENAI_MODEL || 'gpt-4o').trim();
const TEMP = Number(process.env.MIRRA_TEMPERATURE ?? process.env.IROS_TEMPERATURE ?? 0.8);
const TOP_P = Number(process.env.MIRRA_TOP_P ?? process.env.IROS_TOP_P ?? 0.95);
const FREQ = Number(process.env.MIRRA_FREQ_PENALTY ?? process.env.IROS_FREQ_PENALTY ?? 0.2);
const PRES = Number(process.env.MIRRA_PRES_PENALTY ?? process.env.IROS_PRES_PENALTY ?? 0.2);

// ===== ユーティリティ =====
function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : ((init as ResponseInit | undefined)?.['status'] ?? 200);
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-mu-user');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  return new NextResponse(JSON.stringify(data), { status, headers });
}
export async function OPTIONS() {
  return json({ ok: true });
}

function sbService() {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('Supabase env is missing');
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
}

async function callOpenAI(payload: any) {
  const r = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    return { ok: false as const, status: r.status, detail: text };
  }
  const data = await r.json();
  return { ok: true as const, data };
}

const newConvCode = () =>
  `MU-${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 5)}`;

// ---- dev fallback: userCode を取り出す（Cookie → Firebase → ヘッダ → クエリ）----
async function resolveUserCode(req: NextRequest) {
  const cookieUser = req.cookies.get('mu_user_code')?.value?.trim();
  if (cookieUser) return { ok: true as const, userCode: cookieUser };

  const z = await verifyFirebaseAndAuthorize(req);
  if (z.ok && z.allowed && z.userCode) return { ok: true as const, userCode: z.userCode };

  const hUser = req.headers.get('x-mu-user')?.trim();
  const qUser = req.nextUrl.searchParams.get('user_code')?.trim();
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev && (hUser || qUser)) return { ok: true as const, userCode: (hUser || qUser)! };

  const origin = req.headers.get('origin') || '';
  const host = req.headers.get('host') || '';
  const sameOrigin =
    !!origin &&
    (origin.endsWith(host) || origin === `https://${host}` || origin === `http://${host}`);
  if (!isDev && sameOrigin && (hUser || qUser))
    return { ok: true as const, userCode: (hUser || qUser)! };

  return {
    ok: false as const,
    error: 'Missing credentials (Bearer or _session cookie)',
    status: 401 as const,
  };
}

// ===== adapters（handlers は (t: string) => ... を期待）=====
const inferPhaseAdapter = (t: string) => {
  try {
    const res: any = (inferPhaseFn as any)({ text: t });
    return typeof res === 'string' ? res : String(res?.phase ?? '');
  } catch {
    return '';
  }
};

const estimateSelfAdapter = (t: string) => {
  try {
    return (estimateSelfAcceptanceFn as any)({ text: t });
  } catch {
    return null;
  }
};

// ====== 主処理 ======
export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return json({ error: 'OPENAI_API_KEY missing' }, 500);

    // 認証
    const who = await resolveUserCode(req);
    if (!who.ok) return json({ error: who.error }, who.status);
    const userCode = who.userCode;

    // body と分岐判定
    const raw = (await req.json().catch(() => ({}))) as any;
    const conversation_code =
      typeof raw.conversation_code === 'string' && raw.conversation_code.trim()
        ? raw.conversation_code.trim()
        : newConvCode();

    const model = (raw.model || MODEL).trim();
    const temperature = typeof raw.temperature === 'number' ? raw.temperature : TEMP;
    const top_p = typeof raw.top_p === 'number' ? raw.top_p : TOP_P;
    const frequency_penalty =
      typeof raw.frequency_penalty === 'number' ? raw.frequency_penalty : FREQ;
    const presence_penalty = typeof raw.presence_penalty === 'number' ? raw.presence_penalty : PRES;

    // ← モードの堅牢判定（mode が無い/空でも text があれば coach_from_text に寄せる）
    const incomingMode =
      (typeof raw.mode === 'string' && raw.mode.trim()) ||
      (typeof raw.text === 'string' && raw.text.trim() ? 'coach_from_text' : '');

    if (process.env.NODE_ENV !== 'production') {
      console.log('[mui] incoming', {
        mode: incomingMode || '(empty)',
        hasText: !!raw.text,
        userCode,
        conv: conversation_code,
      });
    }

    // ===== format_only =====
    if (incomingMode === 'format_only') {
      const res = await handleFormatOnly(raw, callOpenAI, model, temperature, top_p);
      if (process.env.NODE_ENV !== 'production') {
        console.log('[mui] format_only -> ok:', res.status, 'conv:', conversation_code, 'Q: null');
      }
      // format_only は Q なし
      return json({ ...res.body, conversation_code, q: null }, res.status);
    }

    // ===== coach_from_text =====
    if (incomingMode === 'coach_from_text') {
      const res = await handleCoachFromText(
        userCode,
        conversation_code,
        raw,
        callOpenAI,
        model,
        temperature,
        top_p,
        frequency_penalty,
        presence_penalty,
        sbService,
        chargeIfNeeded,
        inferPhaseAdapter,
        estimateSelfAdapter,
      );
      const qcode = (res?.body as any)?.q?.code ?? null;
      if (process.env.NODE_ENV !== 'production') {
        console.log(
          '[mui] coach_from_text -> status:',
          res.status,
          'conv:',
          conversation_code,
          'Q:',
          qcode,
        );
      }
      return json(res.body, res.status);
    }

    // ===== 通常チャット =====
    const messages = Array.isArray(raw.messages) ? raw.messages.slice(-50) : [];
    const use_kb = raw.use_kb !== false;
    const kb_limit = Number.isFinite(raw.kb_limit)
      ? Math.max(1, Math.min(8, Number(raw.kb_limit)))
      : 4;

    const res = await handleChat(
      userCode,
      conversation_code,
      raw,
      callOpenAI,
      model,
      temperature,
      top_p,
      frequency_penalty,
      presence_penalty,
      retrieveKnowledge,
      nextQFrom,
      inferPhaseAdapter,
      estimateSelfAdapter,
      chargeIfNeeded,
      use_kb,
      kb_limit,
      messages,
      raw.source_type || 'chat',
      sbService,
    );
    const qcode = (res?.body as any)?.q?.code ?? null;
    if (process.env.NODE_ENV !== 'production') {
      console.log('[mui] chat -> status:', res.status, 'conv:', conversation_code, 'Q:', qcode);
    }
    return json(res.body, res.status);
  } catch (e: any) {
    console.error('[Mui API] Error:', e);
    return json({ error: 'Unhandled error', detail: String(e?.message ?? e) }, 500);
  }
}
