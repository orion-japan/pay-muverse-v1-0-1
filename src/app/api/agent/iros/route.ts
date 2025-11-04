// src/app/api/agent/iros/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';
import { IROS_PROMPT } from '@/lib/iros/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(SUPABASE_URL!, SERVICE_ROLE!);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

type Role = 'system' | 'user' | 'assistant';
type Msg = { role: Role; content: string };

type BodyIn = {
  text?: string;
  conversationId?: string;
  messages?: Array<Partial<Msg> & { role?: string }>;
  model?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
};

type IrosResponse = {
  ok: true;
  reply: string;
  rows: Array<string | Record<string, any>>;
  meta: {
    agent: 'iros';
    conversation_id: string;
    layer?: string;
    phase?: 'Inner' | 'Outer';
    qcode?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
    scores?: Record<string, number>;
    noiseAmp?: number;
    g?: number;
    seed?: number | string;
    epsilon?: number;
    __system_used?: string;
  };
};

const __DEV__ = process.env.NODE_ENV !== 'production';
const dbg = (...a: any[]) => { if (__DEV__) console.log('[IROS API]', ...a); };

const json = (data: any, status = 200) =>
  new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    },
  });

export async function OPTIONS() { return json({ ok: true }); }

function lastUserText(messages?: Msg[]) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

function guessPhase(t: string): 'Inner' | 'Outer' {
  return /私|わたし|自分|内側|迷い|不安|孤独|つらい|疲れ/i.test(t) ? 'Inner' : 'Outer';
}
function guessQ(t: string): IrosResponse['meta']['qcode'] {
  const lc = (t || '').toLowerCase();
  if (/[怒苛ムカ]|angry|frustrat/i.test(lc)) return 'Q2';
  if (/不安|心配|焦り|anx|worr|uneasy/i.test(lc)) return 'Q3';
  if (/怖|恐|fear/i.test(lc)) return 'Q4';
  if (/情熱|ワクワク|嬉|喜|excited|passion/i.test(lc)) return 'Q5';
  return 'Q1';
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

function toRole(x?: string): Role | null {
  if (!x) return null;
  const v = x.toLowerCase();
  if (v === 'system' || v === 'user' || v === 'assistant') return v;
  return null;
}
function sanitizeMessages(m?: BodyIn['messages']): Msg[] {
  if (!Array.isArray(m)) return [];
  const out: Msg[] = [];
  for (const raw of m.slice(-40)) {
    const role = toRole(raw.role as any) ?? ('user' as Role);
    const content = typeof raw.content === 'string' ? raw.content : '';
    if (content) out.push({ role, content });
  }
  return out;
}

const isUUID = (s?: string) =>
  !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s || '');

export async function GET() {
  return json({ ok: true, service: 'Iros API', model_hint: 'gpt-4o', time: new Date().toISOString() });
}

export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return json({ error: 'Env OPENAI_API_KEY is missing' }, 500);

    const z = await verifyFirebaseAndAuthorize(req);
    if (!z.ok) return json({ error: z.error }, z.status);
    if (!z.allowed) return json({ error: 'forbidden' }, 403);

    // user_code を唯一の所有キーとして採用（users.user_key 参照はしない）
    const userCode: string = (() => {
      const u: any = z.user;
      if (typeof u === 'string') return u;
      if (u && typeof u.user_code === 'string') return u.user_code;
      if (u && typeof u.uid === 'string') return u.uid;
      return '';
    })();
    if (!userCode) return json({ error: 'user_code_missing' }, 400);

    const body = (await req.json().catch(() => ({}))) as BodyIn;

    const model = (body.model || 'gpt-4o').trim();
    const temperature = typeof body.temperature === 'number' ? body.temperature : 0.3;
    const top_p = typeof body.top_p === 'number' ? body.top_p : 0.7;
    const max_tokens = typeof body.max_tokens === 'number' ? body.max_tokens : undefined;

    const history: Msg[] = sanitizeMessages(body.messages);
    const userTextRaw = String(body.text ?? '').trim();
    const userText = userTextRaw || lastUserText(history);

    const phase = guessPhase(userText);
    const qcode = guessQ(userText);
    const epsilon = 0.4;
    const noiseAmp = phase === 'Outer' ? 0.2 : 0.15;
    const g = 0.8;
    const seed = Date.now() % 100000;

    const system = IROS_PROMPT;
    const messages: Msg[] = [
      { role: 'system', content: system },
      ...history,
      ...(userText ? [{ role: 'user', content: userText } as Msg] : []),
    ];
    const payload: any = { model, messages, temperature, top_p };
    if (max_tokens) payload.max_tokens = max_tokens;

    let reply = '';
    const r = await callOpenAI(payload);
    if (!r.ok) return json({ ok: false, error: 'upstream_error', status: r.status, detail: r.detail }, r.status || 500);
    reply = r.data?.choices?.[0]?.message?.content ?? '';

    if (reply && userText && reply.trim() === userText.trim()) {
      reply = '受け取りました。いまの感じを一言で言うと、どんなトーン？（落ち着く／張りつめる など）';
    }

    // ====== 保存 ======
    let convId: string;
    if (isUUID(body.conversationId)) {
      const { error } = await sb
        .from('iros_conversations')
        .upsert(
          {
            id: body.conversationId,
            user_code: userCode,
            user_key: userCode, // 互換: 列があれば埋める
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'id' },
        );
      if (error) throw new Error(`conv_upsert_failed: ${error.message}`);
      convId = body.conversationId!;
    } else {
      const { data, error } = await sb
        .from('iros_conversations')
        .insert({
          user_code: userCode,
          user_key: userCode, // 互換
          title: '新規セッション',
          updated_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (error) throw new Error(`conv_insert_failed: ${error.message}`);
      convId = String(data.id);
    }

    const title = (userText || reply || '新規セッション').slice(0, 40);
    await sb.from('iros_conversations').update({ title, updated_at: new Date().toISOString() }).eq('id', convId);

    const nowTs = Date.now();
    if (userText) {
      const { error: e1 } = await sb.from('iros_messages').insert({
        conversation_id: convId,
        role: 'user',
        content: userText,
        ts: nowTs,
      });
      if (e1) throw new Error(`msg_user_insert_failed: ${e1.message}`);
    }
    const { error: e2 } = await sb.from('iros_messages').insert({
      conversation_id: convId,
      role: 'assistant',
      content: reply,
      ts: nowTs + 1,
    });
    if (e2) throw new Error(`msg_assist_insert_failed: ${e2.message}`);
    // ====== 保存ここまで ======

    const rows: IrosResponse['rows'] = [
      { key: '観測', value: (userText || '').slice(0, 140) },
      { key: '位相(Phase)', value: phase },
      { key: '主要Qコード', value: qcode },
    ];

    const meta: IrosResponse['meta'] = {
      agent: 'iros',
      conversation_id: convId,
      layer: 'S1',
      phase,
      qcode,
      scores: { S: 0.6, R: 0.2, C: 0.1, I: 0.1 },
      noiseAmp,
      g,
      seed,
      epsilon,
      __system_used: 'IROS_PROMPT',
    };

    return json({ ok: true, reply, rows, meta } as IrosResponse);
  } catch (e: any) {
    if (__DEV__) dbg('unhandled', String(e?.message ?? e));
    return json({ ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) }, 500);
  }
}
