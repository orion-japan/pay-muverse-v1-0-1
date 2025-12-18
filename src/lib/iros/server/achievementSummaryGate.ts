// src/lib/iros/server/achievementSummaryGate.ts
// iros — Achievement Summary Gate (yesterday / last 7 days)
//
// 目的:
// - 「昨日どうだった？」「先週進んだ？」に対して、会話IDをまたいだ記録から“観測”として要約を返す
// - 会話を進める/説教するのではなく、事実ベースの短いサマリを返す
//
// 方針:
// - まずは LLM を使わない最小版（ログ抽出 + ルール要約）
// - 後で「LLM要約版」に差し替えやすい shape にしてある

type PeriodKind = 'yesterday' | 'last7days';

export type AchievementSummaryPeriod = {
  kind: PeriodKind;
  label: string; // 表示用
  startIso: string; // inclusive
  endIso: string; // exclusive
};

export type NormMsg = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
};

export type AchievementSummary = {
  period: AchievementSummaryPeriod;
  stats: {
    messages: number;
    userMessages: number;
    assistantMessages: number;
  };
  highlights: string[]; // 進捗の断片（短文）
  achievements: string[]; // 完了/解消/通過っぽい断片（短文）
  goals: string[]; // 期間内に見えた「目標」候補（短文）
};

/* =========================================================
 * 1) トリガー判定
 * ========================================================= */

export function detectAchievementSummaryPeriod(text: string): AchievementSummaryPeriod | null {
  const t = String(text ?? '').trim();

  // 「昨日」「きのう」「昨日の達成」「昨日どうだった」系
  const yesterdayHit =
    /(昨日|きのう|昨日の|昨日は|昨日どう|昨日どんな|昨日達成|昨日進んだ)/.test(t);

  // 「先週」「一週間」「この1週間」「最近（※ここは last7days に寄せる）」系
  const last7daysHit =
    /(先週|一週間|1週間|７日|7日|この週|今週じゃなくて先週|最近|ここ数日)/.test(t);

  if (!yesterdayHit && !last7daysHit) return null;

  const kind: PeriodKind = yesterdayHit ? 'yesterday' : 'last7days';
  const period = buildPeriod(kind);

  return period;
}

/* =========================================================
 * 2) 期間確定（JST想定：サーバーがUTCでもISOで返す）
 * ========================================================= */

function buildPeriod(kind: PeriodKind): AchievementSummaryPeriod {
  // ここでは「日付境界」をローカル（サーバー）で作る。
  // ※将来「Asia/Tokyo固定」にしたい場合は、date-fns-tz 等に差し替え。
  const now = new Date();

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  if (kind === 'yesterday') {
    const start = new Date(startOfToday);
    start.setDate(start.getDate() - 1);

    const end = new Date(startOfToday); // 今日0時（exclusive）

    return {
      kind,
      label: '昨日',
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    };
  }

  // last7days: 直近7日（今日を含めない、昨日までの7日でも良いが、まずは「直近7日」を採用）
  // ここでは「今日0時」から遡って 7日を区間にする。
  const end = new Date(startOfToday); // 今日0時（exclusive）
  const start = new Date(startOfToday);
  start.setDate(start.getDate() - 7);

  return {
    kind,
    label: '直近7日',
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

/* =========================================================
 * 3) DB取得（iros_messages_normalized）
 * ========================================================= */

export async function loadNormalizedMessagesForPeriod(params: {
  supabase: any; // admin client
  userCode: string;
  startIso: string;
  endIso: string;
  limit?: number;
}): Promise<NormMsg[]> {
  const { supabase, userCode, startIso, endIso, limit = 200 } = params;

  const { data, error } = await supabase
    .from('iros_messages_normalized')
    .select('id, conversation_id, role, content, created_at')
    .eq('user_code', userCode)
    .gte('created_at', startIso)
    .lt('created_at', endIso)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.warn('[IROS][AchSummary] load error', { userCode, startIso, endIso, error });
    return [];
  }

  const rows = (data ?? []) as any[];

  const out: NormMsg[] = [];
  for (const r of rows) {
    const role = String(r?.role ?? '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;

    const content = String(r?.content ?? '').trim();
    if (!content) continue;

    out.push({
      id: String(r?.id ?? ''),
      conversation_id: String(r?.conversation_id ?? ''),
      role: role as 'user' | 'assistant',
      content,
      created_at: String(r?.created_at ?? ''),
    });
  }

  return out;
}

/* =========================================================
 * 4) ルール要約（最小版）
 * ========================================================= */

export function buildAchievementSummary(messages: NormMsg[], period: AchievementSummaryPeriod): AchievementSummary {
  const userMsgs = messages.filter((m) => m.role === 'user');
  const asstMsgs = messages.filter((m) => m.role === 'assistant');

  const norm = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();

  // 完了/解消/通過っぽい
  const doneRe =
    /(解消|直った|治った|直しました|修正した|完了|できた|通った|通りました|成功|OK|うまくいった|マージ|merge|typecheck通|テスト通)/i;

  // 進捗/作業中っぽい
  const progressRe =
    /(実装|整理|分割|移行|追加|削除|確認|調査|原因|再現|対応|進める|やる|やろう|続き|つづき|作る|作成)/i;

  // 目標っぽい（ユーザー発話 + goal recall 返答のどちらでも拾う）
  const goalRe =
    /(今日の目標|目標は|ゴールは|やることは|目的は|目標:|ゴール:)/;

  const achievements: string[] = [];
  const highlights: string[] = [];
  const goals: string[] = [];

  // 重要: 長文は切る（表示に強い）
  const clip = (s: string, max = 80) => {
    const x = norm(s);
    if (x.length <= max) return x;
    return x.slice(0, max - 1) + '…';
  };

  for (const m of messages) {
    const c = norm(m.content);
    if (!c) continue;

    if (doneRe.test(c)) achievements.push(clip(c));
    else if (progressRe.test(c)) highlights.push(clip(c));

    if (goalRe.test(c)) {
      // 「今日の目標は「...」です」などから中身を抜く
      const quoted = c.match(/「(.+?)」/);
      const inner = quoted?.[1]?.trim();
      const g = inner && inner.length >= 3 ? inner : c;
      goals.push(clip(g, 90));
    }
  }

  // 重複排除（順序維持）
  const uniq = (arr: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of arr) {
      const k = norm(x);
      if (!k) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  };

  const summary: AchievementSummary = {
    period,
    stats: {
      messages: messages.length,
      userMessages: userMsgs.length,
      assistantMessages: asstMsgs.length,
    },
    highlights: uniq(highlights).slice(0, 5),
    achievements: uniq(achievements).slice(0, 5),
    goals: uniq(goals).slice(0, 3),
  };

  return summary;
}

/* =========================================================
 * 5) 表示テキスト生成（最小版）
 * ========================================================= */

export function renderAchievementSummaryText(s: AchievementSummary): string {
  const { period, stats, achievements, highlights, goals } = s;

  const lines: string[] = [];

  // 先頭: 観測宣言（評価しない）
  lines.push(`${period.label}の達成サマリです。🪔`);
  lines.push(`（記録: ${stats.messages}件 / user:${stats.userMessages} / assistant:${stats.assistantMessages}）`);

  if (goals.length) {
    lines.push('');
    lines.push('目標候補:');
    for (const g of goals) lines.push(`- ${g}`);
  }

  if (achievements.length) {
    lines.push('');
    lines.push('完了/解消っぽい進捗:');
    for (const a of achievements) lines.push(`- ${a}`);
  }

  if (highlights.length) {
    lines.push('');
    lines.push('動いていた点:');
    for (const h of highlights) lines.push(`- ${h}`);
  }

  if (!goals.length && !achievements.length && !highlights.length) {
    lines.push('');
    lines.push('この期間は「進捗/完了」を判定できる記述が少なめでした。必要なら、達成として残したい1行を置いてください。');
  }

  // 余韻（未来指示しない）
  lines.push('');
  lines.push('必要なら「次に何を残すか」だけ一行で置けます。🪔');

  return lines.join('\n');
}
