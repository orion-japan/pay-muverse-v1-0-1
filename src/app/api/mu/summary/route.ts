export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

/* ===== Supabase (service role) ===== */
function sb() {
  return createClient(SUPABASE_URL!, SERVICE_ROLE!, { auth: { persistSession: false } });
}

/* ===== 小道具 ===== */
type Dist = { q1: number; q2: number; q3: number; q4: number; q5: number };
type QDay = { date: string; q1: number; q2: number; q3: number; q4: number; q5: number };
type CategoryToday = { self: number; vision: number; event: number; ai: number };

const TEMPLATE_VERSION = 'v1';
const SCOPE_DEFAULT = 'qcode';

const jstDateStr = (d = new Date()) => {
  const j = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = j.getFullYear();
  const m = String(j.getMonth() + 1).padStart(2, '0');
  const day = String(j.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const windowDays = (p: { days?: number; start?: string; end?: string }) => {
  if (p.start && p.end) {
    const s = new Date(`${p.start}T00:00:00+09:00`);
    const e = new Date(`${p.end}T00:00:00+09:00`);
    return Math.max(Math.floor((+e - +s) / 86400000) + 1, 0);
  }
  return p.days ?? 30;
};

const recordedDays = (arr: QDay[]) =>
  arr.filter((d) => d.q1 + d.q2 + d.q3 + d.q4 + d.q5 > 0).length;

const sumDist = (arr: QDay[]): Dist =>
  arr.reduce<Dist>(
    (a, d) => ({
      q1: a.q1 + d.q1,
      q2: a.q2 + d.q2,
      q3: a.q3 + d.q3,
      q4: a.q4 + d.q4,
      q5: a.q5 + d.q5,
    }),
    { q1: 0, q2: 0, q3: 0, q4: 0, q5: 0 },
  );

const repQ = (d: Dist): 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | null => {
  const a: Array<['Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5', number]> = [
    ['Q1', d.q1],
    ['Q2', d.q2],
    ['Q3', d.q3],
    ['Q4', d.q4],
    ['Q5', d.q5],
  ];
  const top = a.reduce((x, y) => (y[1] > x[1] ? y : x));
  return top[1] > 0 ? top[0] : null;
};

const streakDays = (arr: QDay[]) => {
  const sorted = [...arr].sort((a, b) => a.date.localeCompare(b.date));
  let s = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const d = sorted[i];
    if (d.q1 + d.q2 + d.q3 + d.q4 + d.q5 > 0) s++;
    else break;
  }
  return s;
};

function buildSummary(args: {
  n: number;
  rep_q: string | null;
  streak: number;
  recorded_days: number;
  window_days: number;
  dist: Dist;
  category_today: CategoryToday;
}) {
  const coverage = args.window_days ? Math.round((args.recorded_days / args.window_days) * 100) : 0;
  const rep = args.rep_q ?? '未記録';
  const distStr = `Q1 ${args.dist.q1} / Q2 ${args.dist.q2} / Q3 ${args.dist.q3} / Q4 ${args.dist.q4} / Q5 ${args.dist.q5}`;
  const catStr = `Self ${args.category_today.self}・Vision ${args.category_today.vision}・Event ${args.category_today.event}・AI ${args.category_today.ai}`;
  const light = args.recorded_days < 7 || coverage < 20;
  const caution = light ? '\n※ 記録が少ないため、傾向は暫定です。' : '';

  const title = `直近${args.n}日のQ総評（代表: ${rep} / 連続${args.streak}日）`;
  const body = [
    `【概況】活動日 ${args.recorded_days}/${args.window_days}（充足率 ${coverage}%）／代表Q ${rep}${caution}`,
    `【習慣チェック】直近の連続記録は ${args.streak} 日です。無理のない頻度で続けましょう。`,
    `【Q分布の要約】${distStr}`,
    `【Vision進捗の整理】実行できた日は短く称賛。停滞日は“条件づくり”に1分でもOK。`,
    `【次の一歩】① 最小行動（3〜10分）／② 同じ時間帯で固定化／③ 記録ハードルを下げる`,
    `【参考】Q合計（${args.n}日）：${distStr}｜当日内訳：${catStr}`,
    `【問い】今週、無理なく繰り返せる「最小の一歩」は何ですか？`,
  ].join('\n');

  return { title, body };
}

/* ===== 内部 API 呼び出し ===== */
async function callJson(req: NextRequest, path: string) {
  const url = new URL(path, req.url);
  return fetch(url.toString(), {
    headers: {
      cookie: req.headers.get('cookie') ?? '',
      authorization: req.headers.get('authorization') ?? '',
    },
    cache: 'no-store',
  });
}
async function postJson(req: NextRequest, path: string, body: any) {
  const url = new URL(path, req.url);
  return fetch(url.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: req.headers.get('cookie') ?? '',
      authorization: req.headers.get('authorization') ?? '',
    },
    body: JSON.stringify(body),
  });
}

/* ===== 冪等：会話 find-or-create ===== */
async function ensureConversation(
  req: NextRequest,
  userCode: string,
  reuseKey: string,
  title: string,
  meta: Record<string, any>,
) {
  try {
    const res = await postJson(req, '/api/agent/muai/conversations', {
      op: 'find_or_create',
      key: reuseKey,
      title,
      meta,
    });
    if (res.ok) {
      const json = await res.json();
      if (json?.threadId) return { threadId: json.threadId as string, reused: !!json.reused };
    }
  } catch {}

  const s = sb();

  let foundId: string | null = null;
  try {
    const { data: found } = await s
      .from('mu_conversations')
      .select('id')
      .eq('user_code', userCode)
      .eq('reuse_key', reuseKey)
      .limit(1);
    if (found && found.length) foundId = found[0].id;
  } catch {}

  if (!foundId) {
    const { data: f2 } = await s
      .from('mu_conversations')
      .select('id')
      .eq('user_code', userCode)
      .eq('title', title)
      .eq('origin_app', 'mu')
      .limit(1);
    if (f2 && f2.length) foundId = f2[0].id;
  }

  if (foundId) return { threadId: foundId, reused: true };

  const base = {
    user_code: userCode,
    title,
    origin_app: 'mu',
    routed_from: meta?.routed_from ?? 'q-summary',
  };
  try {
    const { data: ins, error: e1 } = await s
      .from('mu_conversations')
      .insert({ ...base, reuse_key: reuseKey, meta })
      .select('id')
      .single();
    if (e1) throw e1;
    return { threadId: ins!.id, reused: false };
  } catch {
    const { data: ins2, error: e2 } = await s
      .from('mu_conversations')
      .insert(base)
      .select('id')
      .single();
    if (e2) throw e2;
    return { threadId: ins2!.id, reused: false };
  }
}

/* ====== 本体 ====== */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sp = url.searchParams;

  const z = await verifyFirebaseAndAuthorize(req as any);
  const queryUser = sp.get('user') ?? undefined;
  const userCode = z?.userCode ?? queryUser;
  if (!z.ok || !z.allowed || !userCode) {
    const msg = encodeURIComponent(
      '（サインイン情報が見つかりません。再ログイン後にお試しください）',
    );
    return NextResponse.redirect(new URL(`/chat/new?draft=${msg}`, req.url), { status: 302 });
  }

  const scope = sp.get('scope') ?? SCOPE_DEFAULT;
  const start = sp.get('start') ?? undefined;
  const end = sp.get('end') ?? undefined;
  const days = sp.get('days') ? Math.max(1, Number(sp.get('days'))) : start && end ? undefined : 30;
  const n = windowDays({ days, start, end });

  try {
    const qp = new URLSearchParams();
    if (days && !start && !end) qp.set('days', String(days));
    if (start) qp.set('start', start);
    if (end) qp.set('end', end);
    qp.set('user', String(userCode));

    const dailyRes = await callJson(req, `/api/q/daily_with_carry?${qp.toString()}`);
    if (!dailyRes.ok) throw new Error(`daily_with_carry ${dailyRes.status}`);
    const qdays: QDay[] = await dailyRes.json();

    const catRes = await callJson(
      req,
      `/api/q/category_today?user=${encodeURIComponent(String(userCode))}`,
    );
    if (!catRes.ok) throw new Error(`category_today ${catRes.status}`);
    const category_today: CategoryToday = await catRes.json();

    const window_days = n;
    const recorded_days = recordedDays(qdays);
    const dist = sumDist(qdays);
    const rq = repQ(dist);
    const streak = streakDays(qdays);

    if (recorded_days === 0) {
      const draft =
        '（記録が見つかりませんでした。まずは今日の最小行動を1つだけ登録してみましょう）';
      return NextResponse.redirect(
        new URL(`/chat/new?draft=${encodeURIComponent(draft)}`, req.url),
        { status: 302 },
      );
    }

    const { title, body } = buildSummary({
      n,
      rep_q: rq,
      streak,
      recorded_days,
      window_days,
      dist,
      category_today,
    });

    const date_jst = jstDateStr();
    const reuseKey = `${userCode}:${date_jst}:${scope}:${n}`;
    const meta = {
      scope,
      days: n,
      date_jst,
      rep_q: rq,
      template_version: TEMPLATE_VERSION,
      routed_from: 'q-summary',
    };

    const { threadId } = await ensureConversation(
      req,
      String(userCode),
      reuseKey,
      `Q総評 / ${date_jst} / ${rq ?? '-'}`,
      meta,
    );

    const turnRes = await postJson(req, '/api/mu/turns', {
      conv_id: threadId,
      role: 'assistant',
      content: [
        `# ${title}`,
        '',
        body,
        '',
        `---`,
        `meta: summary_id=null, snapshot_id=null, template_version=${TEMPLATE_VERSION}, scope=${scope}, days=${n}, rep_q=${rq ?? ''}, streak_days=${streak}, generated_at=${new Date().toISOString()}`,
      ].join('\n'),
    });
    if (!turnRes.ok) throw new Error(`turns ${turnRes.status}`);

    // ★ ここを /chat?open=<convId> に変更
    return NextResponse.redirect(new URL(`/chat?open=${threadId}`, req.url), { status: 302 });
  } catch (e: any) {
    const msg = `（Q総評の生成に失敗しました: ${e?.message ?? e}. 時間をおいて再度お試しください）`;
    return NextResponse.redirect(new URL(`/chat/new?draft=${encodeURIComponent(msg)}`, req.url), {
      status: 302,
    });
  }
}
