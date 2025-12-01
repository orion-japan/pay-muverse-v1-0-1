// src/lib/iros/topicState.ts
// Iros Topic Memory
// - ユーザーごとの「トピック記憶」を管理
// - upsert 時に last_used_at / hit_count を更新
// - 非 core トピックが増えすぎたら古いものから memo_summary を掃除する

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY!;

const DEBUG_TOPIC_STATE = process.env.DEBUG_IROS_TOPIC_STATE === '1';

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

export type TopicImportance = 'core' | 'important' | 'casual';
export type TopicPhase = 'Inner' | 'Outer' | null;

export type IrosTopicStateRow = {
  id: string;
  user_code: string;
  topic: string;
  topic_key: string | null;
  topic_label: string | null;
  latest_self_acceptance: number | null;
  latest_input_text: string | null;
  last_turn_at: string;
  created_at: string;
  updated_at: string;
  memo_summary: string | null;
  importance: TopicImportance;
  last_used_at: string | null;
  hit_count: number;
  last_q_code: string | null;
  last_depth: string | null;
  last_phase: TopicPhase;
};

// src/lib/iros/topicState.ts

export type UpsertTopicStateParams = {
  userCode: string;

  /** 内部キー（例: "work_boss", "love_partner_A"） */
  topicKey: string;

  /** 画面やログで見やすいラベル（例: "上司との関係"） */
  topicLabel?: string | null;

  /** レガシーの topic カラムに入れる文字列（未指定なら topicKey を使う） */
  rawTopicText?: string | null;

  /** 直近解析されたメタ（任意） */
  selfAcceptance?: number | null;
  inputText?: string | null;
  qCode?: string | null;
  depth?: string | null;
  phase?: TopicPhase;

  /** importance を上書きしたいときに指定（基本は既存値を尊重） */
  importanceHint?: TopicImportance;

  /** このターンの created_at / last_turn_at に使うタイムスタンプ */
  turnCreatedAt?: string | null;
};


/** ユーザーごとの非 core トピック上限 */
const NON_CORE_TOPIC_LIMIT = 16;

/**
 * 1. (user_code, topic_key) で行を探す
 * 2. あれば更新／なければ作成
 * 3. 非 core トピックが多すぎる場合、古くて使われていないものから memo_summary を掃除
 */
export async function upsertTopicStateWithCleanup(
  params: UpsertTopicStateParams
): Promise<IrosTopicStateRow | null> {
  const nowIso = new Date().toISOString();
  const {
    userCode,
    topicKey,
    topicLabel = null,
    rawTopicText = null,
    selfAcceptance = null,
    inputText = null,
    qCode = null,
    depth = null,
    phase = null,
    importanceHint,
  } = params;

  if (!userCode || !topicKey) {
    if (DEBUG_TOPIC_STATE) {
      console.warn('[IROS][topicState] missing userCode or topicKey', {
        userCode,
        topicKey,
      });
    }
    return null;
  }

  // 1) 既存レコードを取得
  const { data: existingRows, error: selectError } = await supabaseAdmin
    .from('iros_topic_state')
    .select('*')
    .eq('user_code', userCode)
    .eq('topic_key', topicKey);

  if (selectError) {
    if (DEBUG_TOPIC_STATE) {
      console.error('[IROS][topicState] select error', selectError);
    }
    return null;
  }

  const existing = existingRows && existingRows[0];

  let row: IrosTopicStateRow | null = null;

  if (!existing) {
    // 2-a) 新規作成
    const insertPayload = {
      user_code: userCode,
      topic: rawTopicText ?? topicKey, // 既存の topic カラムも埋めておく
      topic_key: topicKey,
      topic_label: topicLabel,
      latest_self_acceptance:
        typeof selfAcceptance === 'number' ? selfAcceptance : null,
      latest_input_text: inputText ?? null,
      last_turn_at: nowIso,
      // created_at / updated_at は DEFAULT now() に任せる
      memo_summary: null,
      importance: importanceHint ?? ('casual' as TopicImportance),
      last_used_at: nowIso,
      hit_count: 1,
      last_q_code: qCode ?? null,
      last_depth: depth ?? null,
      last_phase: phase ?? null,
    };

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('iros_topic_state')
      .insert(insertPayload)
      .select('*');

    if (insertError) {
      if (DEBUG_TOPIC_STATE) {
        console.error('[IROS][topicState] insert error', insertError);
      }
    } else if (inserted && inserted[0]) {
      row = inserted[0] as IrosTopicStateRow;
    }
  } else {
    // 2-b) 既存更新
    const nextHitCount =
      typeof existing.hit_count === 'number' ? existing.hit_count + 1 : 1;

    const nextImportance: TopicImportance =
      existing.importance ??
      importanceHint ??
      ('casual' as TopicImportance);

    const updatePayload = {
      topic: existing.topic || rawTopicText || topicKey,
      topic_key: topicKey,
      topic_label: topicLabel ?? existing.topic_label,
      latest_self_acceptance:
        typeof selfAcceptance === 'number'
          ? selfAcceptance
          : existing.latest_self_acceptance,
      latest_input_text: inputText ?? existing.latest_input_text,
      last_turn_at: nowIso,
      updated_at: nowIso,
      importance: nextImportance,
      last_used_at: nowIso,
      hit_count: nextHitCount,
      last_q_code: qCode ?? existing.last_q_code,
      last_depth: depth ?? existing.last_depth,
      last_phase: phase ?? existing.last_phase,
    };

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('iros_topic_state')
      .update(updatePayload)
      .eq('id', existing.id)
      .select('*');

    if (updateError) {
      if (DEBUG_TOPIC_STATE) {
        console.error('[IROS][topicState] update error', updateError);
      }
      row = existing as IrosTopicStateRow;
    } else if (updated && updated[0]) {
      row = updated[0] as IrosTopicStateRow;
    }
  }

  // 3) 非 core トピックの件数が多すぎる場合は古いものから memo_summary を掃除
  await cleanupNonCoreTopicsForUser(userCode);

  if (DEBUG_TOPIC_STATE) {
    console.log('[IROS][topicState] upsert+cleanup done', {
      userCode,
      topicKey,
    });
  }

  return row;
}

/**
 * ユーザーごとの非 core トピックを数え、
 * LIMIT を超えている場合は「古くて・ほとんど使われていないもの」から
 * memo_summary を NULL にしていく。
 *
 * ※ 行自体は消さず、「すぐ使えるエピソードメモ」だけ整理する。
 */
async function cleanupNonCoreTopicsForUser(
  userCode: string,
  limit: number = NON_CORE_TOPIC_LIMIT
): Promise<void> {
  // core 以外のトピックのみ対象
  const { data: rows, error } = await supabaseAdmin
    .from('iros_topic_state')
    .select(
      'id, user_code, importance, last_used_at, hit_count, memo_summary'
    )
    .eq('user_code', userCode)
    .neq('importance', 'core')
    .order('last_used_at', { ascending: true, nullsFirst: true })
    .order('hit_count', { ascending: true });

  if (error) {
    if (DEBUG_TOPIC_STATE) {
      console.error('[IROS][topicState] cleanup select error', error);
    }
    return;
  }

  if (!rows || rows.length <= limit) {
    return;
  }

  const overflowCount = rows.length - limit;
  const targets = rows.slice(0, overflowCount).filter((r) => r.memo_summary);

  if (targets.length === 0) {
    return;
  }

  const ids = targets.map((r) => r.id);

  const { error: updateError } = await supabaseAdmin
    .from('iros_topic_state')
    .update({ memo_summary: null })
    .in('id', ids);

  if (updateError && DEBUG_TOPIC_STATE) {
    console.error('[IROS][topicState] cleanup update error', updateError);
  }
}

/**
 * topic_key ベースで 1件読み出す簡易ヘルパー。
 * （今後、relatedContext 構築時などで利用予定）
 */
export async function loadTopicStateByKey(
  userCode: string,
  topicKey: string
): Promise<IrosTopicStateRow | null> {
  const { data, error } = await supabaseAdmin
    .from('iros_topic_state')
    .select('*')
    .eq('user_code', userCode)
    .eq('topic_key', topicKey)
    .limit(1);

  if (error) {
    if (DEBUG_TOPIC_STATE) {
      console.error('[IROS][topicState] load by key error', error);
    }
    return null;
  }

  if (!data || !data[0]) return null;
  return data[0] as IrosTopicStateRow;
}
// ---- 軽い読み出し（relatedContext 用）ヘルパー ----------------

/**
 * LLM に渡しやすい「トピック文脈」の最小情報。
 * （闇/リメイクのテキストは memo_summary に載せていく想定）
 */
export type TopicContextSnippet = {
  topicKey: string;
  label: string | null;
  summary: string | null;
  lastTurnAt: string | null;
  selfAcceptance: number | null;
};

/**
 * ユーザー＋トピックキーから、簡易的な文脈スニペットを作る。
 * - 行がなければ null
 * - summary は memo_summary が優先、なければ latest_input_text
 */
export async function buildTopicContextSnippet(
  userCode: string,
  topicKey: string
): Promise<TopicContextSnippet | null> {
  const row = await loadTopicStateByKey(userCode, topicKey);
  if (!row) return null;

  const sa =
    typeof row.latest_self_acceptance === 'number'
      ? Number(row.latest_self_acceptance)
      : null;

  return {
    topicKey,
    label: row.topic_label ?? row.topic ?? null,
    summary: row.memo_summary ?? row.latest_input_text ?? null,
    lastTurnAt: row.last_turn_at ?? null,
    selfAcceptance: sa,
  };
}

/**
 * TopicContextSnippet を 1 つのテキストに整形する。
 * - system / assistant プロンプトにそのまま埋め込める想定
 */
export function formatTopicContextSnippet(snippet: TopicContextSnippet): string {
  const lines: string[] = [];

  const title = snippet.label || snippet.topicKey;
  if (title) {
    lines.push(`◆トピック: ${title}`);
  }

  if (snippet.summary) {
    lines.push(`・最近の流れ: ${snippet.summary}`);
  }

  if (snippet.selfAcceptance != null) {
    const saStr = snippet.selfAcceptance.toFixed(2);
    lines.push(`・最近の自己受容度: ${saStr}`);
  }

  if (snippet.lastTurnAt) {
    lines.push(`・最終更新: ${snippet.lastTurnAt}`);
  }

  return lines.join('\n');
}
