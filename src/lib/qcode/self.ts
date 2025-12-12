// src/lib/qcode/self.ts
import { writeQCodeWithEnv } from '@/lib/qcode/qcode-adapter';

type Q = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

const QCOLORS: Record<Q, string> = {
  Q1: '#E0F2FE',
  Q2: '#DCFCE7',
  Q3: '#FEF3C7',
  Q4: '#FEE2E2',
  Q5: '#EDE9FE',
};

function jstDate(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function timeBucket(d = new Date()) {
  // 早朝/朝/昼/夕/夜/深夜
  const h = new Date(d.getTime() + 9 * 3600 * 1000).getUTCHours();
  if (h >= 4 && h < 7) return 'early';
  if (h >= 7 && h < 11) return 'morning';
  if (h >= 11 && h < 15) return 'noon';
  if (h >= 15 && h < 18) return 'evening';
  if (h >= 18 && h < 24) return 'night';
  return 'midnight';
}

function smallJitter<QT extends Q>(q: QT): Q {
  const order: Q[] = ['Q2', 'Q1', 'Q3', 'Q4'];
  if (Math.random() > 0.12) return q;
  const i = order.indexOf(q);
  if (i < 0) return q;
  const ni = Math.max(0, Math.min(order.length - 1, i + (Math.random() < 0.5 ? -1 : 1)));
  const to = order[ni];
  // Q2↔Q4の大ジャンプ抑止
  if ((q === 'Q2' && to === 'Q4') || (q === 'Q4' && to === 'Q2')) return q;
  return to;
}

// ====== streakなど軽い指標 ======
async function getDailyStreak(user_code: string, days = 14) {
  const from = jstDate(new Date(Date.now() - (days - 1) * 86400000));

  // ここは “自己投稿の指標” なので、Qログ統一とは別でOK
  const { supabaseAdmin } = await import('@/lib/supabaseAdmin');

  const { data, error } = await supabaseAdmin
    .from('self_posts')
    .select('created_at')
    .eq('user_code', user_code)
    .gte('created_at', from + ' 00:00:00+09');

  if (error) return { streakPost: 0, posts: 0 };

  // 日別ユニーク
  const set = new Set<string>();
  for (const r of data ?? []) {
    const d = new Date(r.created_at);
    set.add(jstDate(d));
  }
  // 末尾から連続
  let streak = 0;
  for (let i = 0; i < days; i++) {
    const dd = jstDate(new Date(Date.now() - i * 86400000));
    if (set.has(dd)) streak++;
    else break;
  }
  return { streakPost: streak, posts: set.size };
}

// ====== Reaction → sentiment ======
export function mapReactionToSentiment(emojiOrKey: string): number {
  const k = (emojiOrKey || '').toLowerCase();
  if (['👍', '❤️', 'like', 'heart', 'love'].includes(k)) return 0.7;
  if (['🙏', '✨', 'pray', 'bless', 'sparkles'].includes(k)) return 0.5;
  if (['😮', 'wow', 'surprise'].includes(k)) return 0.2;
  if (['😢', '💦', 'tired', 'sad'].includes(k)) return -0.4;
  if (['😡', 'angry'].includes(k)) return -0.7;
  return 0.0;
}

// ====== Q決定（投稿） ======
function decideQForPost(streak: number): { q: Q; hint: string; conf: number } {
  if (streak >= 5) return { q: 'Q2', hint: '継続投稿で安定', conf: 0.75 };
  if (streak >= 2) return { q: 'Q1', hint: '投稿の習慣化', conf: 0.68 };
  return { q: 'Q3', hint: '投稿リズムが不安定', conf: 0.6 };
}

// ====== Q決定（コメント） ======
function decideQForComment(): { q: Q; hint: string; conf: number } {
  // コメントは関与のサイン → デフォ Q1 寄り
  return { q: 'Q1', hint: '関与度（コメント）', conf: 0.65 };
}

// ====== Q決定（リアクション） ======
function decideQForReaction(sent: number): { q: Q; hint: string; conf: number } {
  if (sent >= 0.6) return { q: 'Q2', hint: '前向きリアクション', conf: 0.7 };
  if (sent >= 0.2) return { q: 'Q1', hint: 'やや前向き', conf: 0.65 };
  if (sent <= -0.6) return { q: 'Q4', hint: '強いネガ', conf: 0.72 };
  if (sent <= -0.2) return { q: 'Q3', hint: 'やや落ち込み', conf: 0.64 };
  return { q: 'Q1', hint: '中立', conf: 0.6 };
}

// ========== 公開関数：各アクション時に呼ぶだけ ==========

export async function recordQOnSelfPost(p: {
  user_code: string;
  post_id: string;
  text_len?: number;
}) {
  const { streakPost } = await getDailyStreak(p.user_code, 14);
  let { q, hint, conf } = decideQForPost(streakPost);
  q = smallJitter(q);

  // 返却用（UIで必要なら使える）
  const q_code_local = {
    q,
    confidence: conf,
    hint,
    color_hex: QCOLORS[q],
    version: 'qmap.v0.3.2',
    by: 'sofia',
    meta: {
      source: 'self_post',
      for_date: jstDate(),
      time_bucket: timeBucket(),
      post_id: p.post_id,
      text_len: p.text_len ?? null,
      streak_post_14d: streakPost,
    },
  };

  try {
    await writeQCodeWithEnv({
      user_code: p.user_code,
      source_type: 'self',
      intent: 'self_post',
      q,
      stage: 'S1',
      layer: 'inner',
      polarity: 'now',
      post_id: p.post_id, // uuidでなくても adapter 側で extra に退避される
      extra: {
        action: 'self_post',
        ...q_code_local,
      },
    });
  } catch (e: any) {
    console.warn('[qcode/self] recordQOnSelfPost warn:', e?.message ?? e);
  }

  return q_code_local;
}

export async function recordQOnSelfComment(p: {
  user_code: string;
  post_id: string;
  comment_id: string;
}) {
  let { q, hint, conf } = decideQForComment();
  q = smallJitter(q);

  const q_code_local = {
    q,
    confidence: conf,
    hint,
    color_hex: QCOLORS[q],
    version: 'qmap.v0.3.2',
    by: 'sofia',
    meta: {
      source: 'self_comment',
      for_date: jstDate(),
      time_bucket: timeBucket(),
      post_id: p.post_id,
      comment_id: p.comment_id,
    },
  };

  try {
    await writeQCodeWithEnv({
      user_code: p.user_code,
      source_type: 'self',
      intent: 'comment',
      q,
      stage: 'S1',
      layer: 'inner',
      polarity: 'now',
      post_id: p.post_id,
      extra: {
        action: 'self_comment',
        comment_id: p.comment_id,
        ...q_code_local,
      },
    });
  } catch (e: any) {
    console.warn('[qcode/self] recordQOnSelfComment warn:', e?.message ?? e);
  }

  return q_code_local;
}

export async function recordQOnSelfReaction(p: {
  user_code: string;
  post_id: string;
  reaction: string; // emoji or key
}) {
  const sent = mapReactionToSentiment(p.reaction);
  let { q, hint, conf } = decideQForReaction(sent);
  q = smallJitter(q);

  const q_code_local = {
    q,
    confidence: conf,
    hint,
    color_hex: QCOLORS[q],
    version: 'qmap.v0.3.2',
    by: 'sofia',
    meta: {
      source: 'self_reaction',
      for_date: jstDate(),
      time_bucket: timeBucket(),
      post_id: p.post_id,
      reaction: p.reaction,
      sentiment: sent,
    },
  };

  try {
    await writeQCodeWithEnv({
      user_code: p.user_code,
      source_type: 'self',
      intent: 'comment',
      q,
      stage: 'S1',
      layer: 'inner',
      polarity: 'now',
      post_id: p.post_id,
      extra: {
        action: 'self_reaction',
        reaction: p.reaction,
        sentiment: sent,
        ...q_code_local,
      },
    });
  } catch (e: any) {
    console.warn('[qcode/self] recordQOnSelfReaction warn:', e?.message ?? e);
  }

  return q_code_local;
}
