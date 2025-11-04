// 既存スキーマ準拠：q_code_logs(q_code: jsonb), user_q_codes(q_code: jsonb)
import { db } from '../db';
import crypto from 'node:crypto';
import { AffectAnalysis, QResult } from './types';

export type LogParams = {
  user_code: string;
  source_type: string; // 'mirra'|'mu'|'sofia'|'habit'|'event'...
  agent?: string | null; // 'mirra'|'mu'|'sofia'
  conversation_id?: string | null;
  message_id?: string | null;
  turn_no?: number | null;

  analysis: AffectAnalysis; // analyzeAffect の結果
  reply_excerpt?: string | null; // 上位120字など
  extra_meta?: any; // 任意のメタ（json保存）
  owner_user_code?: string | null;
  actor_user_code?: string | null;

  prev_hash?: string | null;
};

function nowISO() {
  return new Date().toISOString();
}

export async function logQEvent(p: LogParams) {
  const hasDB = !!process.env.DATABASE_URL;
  const id = crypto.randomUUID();

  // q_code（JSONB）へ整形（既存列名に合わせる）
  const qJson = normalizeQ(p.analysis.q);

  // Console ログ（観測しやすいように）
  console.log('[qlog.insert]', {
    at: nowISO(),
    id,
    user: p.user_code,
    source: p.source_type,
    agent: p.agent ?? null,
    conversation_id: p.conversation_id ?? null,
    q: qJson,
    intent: p.analysis.intent,
    phase: p.analysis.phase,
  });

  if (!hasDB) return { id, inserted: false };

  const text = `
    INSERT INTO public.q_code_logs (
      id, user_code, source_type, agent, conversation_id, message_id, turn_no,
      q_code, intent, phase, self_acceptance, relation,
      reply_excerpt, meta, prev_hash, curr_hash, created_at,
      owner_user_code, actor_user_code
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8::jsonb, $9::jsonb, $10, $11::numeric, $12::jsonb,
      $13, $14::jsonb, $15, $16, NOW(),
      $17, $18
    )
  `;
  const curr_hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ id, q: qJson, user: p.user_code, t: Date.now() }))
    .digest('hex');

  await db.query(text, [
    id,
    p.user_code,
    p.source_type,
    p.agent ?? null,
    p.conversation_id ?? null,
    p.message_id ?? null,
    p.turn_no ?? null,
    JSON.stringify(qJson),
    JSON.stringify(p.analysis.intent),
    p.analysis.phase,
    p.analysis.selfAcceptance.score,
    JSON.stringify(p.analysis.relation),
    p.reply_excerpt ?? null,
    JSON.stringify(p.extra_meta ?? {}),
    p.prev_hash ?? null,
    curr_hash,
    p.owner_user_code ?? null,
    p.actor_user_code ?? null,
  ]);

  // user_q_codes の現在値を upsert（最小）
  const upsert = `
    INSERT INTO public.user_q_codes (user_code, q_code, phase, updated_at, source_type, self_acceptance)
    VALUES ($1, $2::jsonb, $3, NOW(), $4, $5)
    ON CONFLICT (user_code) DO UPDATE
    SET q_code = EXCLUDED.q_code,
        phase = EXCLUDED.phase,
        updated_at = NOW(),
        source_type = EXCLUDED.source_type,
        self_acceptance = EXCLUDED.self_acceptance
  `;
  await db.query(upsert, [
    p.user_code,
    JSON.stringify(qJson),
    p.analysis.phase,
    p.source_type,
    p.analysis.selfAcceptance.score,
  ]);

  return { id, inserted: true, curr_hash };
}

function normalizeQ(q: QResult) {
  return {
    code: q.code,
    confidence: q.confidence,
    hint: q.hint ?? undefined,
    color_hex: q.color_hex ?? undefined,
    stage: q.stage ?? undefined,
  };
}
