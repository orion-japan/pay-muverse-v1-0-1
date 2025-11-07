// src/app/api/agent/iros/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';
import { createClient } from '@supabase/supabase-js';
import { analyzeFocus } from '@/lib/iros/focusCore';
import { generateIrosReply } from '@/lib/iros/generate';

// 非言語型（config.ts に定義済）を参照可能に
import type { ResonanceState, IntentPulse } from '@/lib/iros/config';

const sb = createClient(SUPABASE_URL!, SERVICE_ROLE!);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

type Role = 'system' | 'user' | 'assistant';
type Msg = { role: Role; content: string };

type BodyIn = {
  text?: string;
  conversationId?: string;
  messages?: Array<Partial<Msg> & { role?: string }>;
  model?: string;
  temperature?: number;
  top_p?: number;            // 互換のため受けるが未使用
  max_tokens?: number;

  // ★ 追加（任意・非言語）
  resonance?: ResonanceState;
  intent?: IntentPulse;
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
  };
  debug?: {
    phase: string;
    depth: string;
    q: string;
    qName: string;
    qConf: number;
    domain: string;
    protectedFocus: string;
    anchors: string[];
    action: string;
    qtrail?: any[];
    qstate?: any;
    pipeline: 'generateIrosReply';
    // ★ 非言語の受理確認
    resonance?: ResonanceState | null;
    intent?: IntentPulse | null;
  };
};

const __DEV__ = process.env.NODE_ENV !== 'production';

const json = (data: any, status = 200) =>
  new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Debug',
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
    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    if (content) out.push({ role, content });
  }
  return out;
}

const isUUID = (s?: string) =>
  !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s || '');

export async function GET() {
  return json({ ok: true, service: 'Iros API', model_hint: process.env.IROS_MODEL || 'gpt-4o-mini', time: new Date().toISOString() });
}

export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return json({ error: 'Env OPENAI_API_KEY is missing' }, 500);

    // 認可（Firebase）
    const z = await verifyFirebaseAndAuthorize(req);
    if (!z.ok) return json({ error: z.error }, z.status);
    if (!z.allowed) return json({ error: 'forbidden' }, 403);

    // user_code 抽出（唯一キー）
    const userCode: string = (() => {
      const u: any = z.user;
      if (typeof u === 'string') return u;
      if (u && typeof u.user_code === 'string') return u.user_code;
      if (u && typeof u.uid === 'string') return u.uid;
      return '';
    })();
    if (!userCode) return json({ error: 'user_code_missing' }, 400);

    const body = (await req.json().catch(() => ({}))) as BodyIn;

    // モデル/生成パラメータ
    const model = (body.model || process.env.IROS_MODEL || 'gpt-4o-mini').trim();
    const temperature = typeof body.temperature === 'number' ? body.temperature : 0.45;
    const max_tokens = typeof body.max_tokens === 'number' ? body.max_tokens : 640;

    // 履歴＆ユーザー発話
    const history: Msg[] = sanitizeMessages(body.messages);
    const userTextRaw = String(body.text ?? '').trim();
    const userText = userTextRaw || lastUserText(history);
    if (!userText) return json({ ok: false, error: 'empty_text' }, 400);

    // Qコード/位相・深度（本番には出さないが、保存とデバッグで使用）
    const focus = analyzeFocus(userText);

    // ===== 生成（★ 非言語を必ず渡す） =====
    const reply = await generateIrosReply({
      userText,
      history,
      model,
      temperature,
      max_tokens,
      apiKey: OPENAI_API_KEY,
      resonance: body.resonance,  // ← 追加
      intent: body.intent,        // ← 追加
    });

    // ====== 会話の保存 ======
    let convId: string;
    if (isUUID(body.conversationId)) {
      const { error } = await sb
        .from('iros_conversations')
        .upsert(
          {
            id: body.conversationId,
            user_code: userCode,
            user_key: userCode, // 互換
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

    const nowTs = Date.now();

    // user メッセージ保存
    const { error: e1 } = await sb.from('iros_messages').insert({
      conversation_id: convId,
      role: 'user',
      content: userText,
      ts: nowTs,
    });
    if (e1) throw new Error(`msg_user_insert_failed: ${e1.message}`);

    // assistant メッセージ保存
    const { error: e2 } = await sb.from('iros_messages').insert({
      conversation_id: convId,
      role: 'assistant',
      content: reply,
      ts: nowTs + 1,
    });
    if (e2) throw new Error(`msg_assist_insert_failed: ${e2.message}`);

    // 互換 rows/meta（軽量）
    const rows: IrosResponse['rows'] = [
      { key: '観測', value: (userText || '').slice(0, 140) },
      { key: '位相(Phase)', value: focus.phase },
      { key: '主要Qコード', value: focus.q },
    ];

    const meta: IrosResponse['meta'] = {
      agent: 'iros',
      conversation_id: convId,
      layer: 'S1',
      phase: focus.phase,
      qcode: focus.q,
      scores: { S: 0.6, R: 0.2, C: 0.1, I: 0.1 }, // 互換用ダミー
      noiseAmp: focus.phase === 'Outer' ? 0.2 : 0.15,
      g: 0.8,
      seed: Date.now() % 100000,
      epsilon: 0.4,
    };

    // —— デバッグ可視化（本番では出さない）
    const isDebug =
      __DEV__ || process.env.IROS_DEBUG === '1' || req.headers.get('x-debug') === '1';

    let debugExtra: any = undefined;
    if (isDebug) {
      try {
        const { data: lastTrail } = await sb.rpc('iros_qtrail_last', { conv: convId, k: 8 }).select();
        const { data: qState }   = await sb.rpc('iros_q_state', { conv: convId }).select();
        debugExtra = {
          qtrail: Array.isArray(lastTrail) ? lastTrail : [],
          qstate: Array.isArray(qState) ? qState[0] : qState,
        };
      } catch {
        debugExtra = { qtrail: [], qstate: null };
      }
    }

    const payload: IrosResponse = {
      ok: true,
      reply,
      rows,
      meta,
      ...(isDebug
        ? {
            debug: {
              phase: String(focus.phase),
              depth: String(focus.depth),
              q: String(focus.q),
              qName: String(focus.qName),
              qConf: Number(focus.qConf),
              domain: String(focus.domain),
              protectedFocus: String(focus.protectedFocus),
              anchors: focus.anchors as string[],
              action: String(focus.action),
              ...(debugExtra ?? {}),
              pipeline: 'generateIrosReply',
              // 受理確認
              resonance: body.resonance ?? null,
              intent: body.intent ?? null,
            },
          }
        : {}),
    };

    return json(payload);
  } catch (e: any) {
    if (__DEV__) console.error('[IROS][unhandled]', String(e?.message ?? e));
    return json({ ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) }, 500);
  }
}
