// app/api/agent/muai/reply/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

/* ---------------- utils ---------------- */
const DEV = process.env.NODE_ENV !== 'production';
const dlog = (...a: any[]) => { if (DEV) console.info(...a); };
const nowIso = () => new Date().toISOString();

function sb() {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('Supabase env missing');
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
}

function rid() {
  return Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36);
}

/** 安全なタイトル（最大120） */
function safeTitle(s: string) {
  return (s || 'Mu 会話').slice(0, 120);
}

/** 期間を短く表示（8/31–9/29） */
function compactDateLabel(src: string) {
  const range = src.match(
    /(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})\s*[〜~\-–—]{1,3}\s*(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/,
  );
  if (range) {
    const [, , m1, d1, , m2, d2] = range;
    return `${Number(m1)}/${Number(d1)}–${Number(m2)}/${Number(d2)}`;
  }
  const single = src.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (single) {
    const [, , m, d] = single;
    return `${Number(m)}/${Number(d)}`;
  }
  return '';
}

/** 「Q2 / Ｑ２」などの抽出（半角・全角どちらもOK） */
function extractQ(src: string) {
  if (!src) return '';
  const map: Record<string, string> = { Ｑ: 'Q', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5' };
  const norm = src.replace(/[Ｑ１２３４５]/g, (ch) => map[ch] ?? ch);
  const m = norm.match(/(?:^|[\s\p{P}])Q\s*([1-5])(?=$|[\s\p{P}])/u);
  return m ? `Q${m[1]}` : '';
}

/** 短い会話タイトル（「Q総評 8/31–9/29 Q2」など） */
function makeShortTitle(raw?: string, maxLen = 40) {
  const s = (raw ?? '').trim();
  const date = compactDateLabel(s);
  const q = extractQ(s);
  const base = ['Q総評', date || '', q || ''].filter(Boolean).join(' ');
  const out = base || safeTitle(raw ?? 'Q総評');
  return out.length <= maxLen ? out : out.slice(0, maxLen);
}

/** 「【Qコード総評】……」ユーザー入力の表示テキストを短くする */
function simplifyQSummaryDisplay(raw: string) {
  if (!raw.includes('【Qコード総評】')) return null;
  const headerLine = raw.split('\n').find((l) => l.includes('【Qコード総評】')) ?? raw;
  const m = headerLine.match(/【Qコード総評】\s*([0-9／\/\-.]+)\s*[〜~\-–—]\s*([0-9／\/\-.]+)/);
  if (m) {
    return `【Qコード総評】${m[1].replaceAll('/', '-')} 〜 ${m[2].replaceAll('/', '-')}`;
  }
  return '【Qコード総評】';
}

/** reuse_key 用の軽い正規化 */
function normalizeKey(s: string) {
  return s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_.:]/g, '').slice(0, 100);
}

/** 長文安全トリム（全角混在でも安全にカウント） */
function safeTrim(input: string | undefined, max = 2000) {
  if (!input) return '';
  if (input.length <= max) return input;
  return input.slice(0, max - 1) + '…';
}

/* ---- Q自動推定（明示Qが無いとき用） ---- */
const Q_COLORS: Record<'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5', { base: string; mix: string; hex: string }> = {
  Q1: { base: 'White', mix: 'Gold',  hex: '#D4B106' },
  Q2: { base: 'Green', mix: 'Teal',  hex: '#2BA44E' },
  Q3: { base: 'Yellow', mix: 'Brown',hex: '#D4A017' },
  Q4: { base: 'Blue',  mix: 'Navy',  hex: '#2952A3' },
  Q5: { base: 'Red',   mix: 'Orange',hex: '#E5532D' },
};
type QCode = keyof typeof Q_COLORS; // 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5'
const isQCode = (v: any): v is QCode => v === 'Q1' || v === 'Q2' || v === 'Q3' || v === 'Q4' || v === 'Q5';

function inferQFromText(text: string): QCode {
  if (/(怒|いらいら|伸び|挑戦|焦り)/.test(text)) return 'Q2';
  if (/(不安|整え|安定|土台|落ち着)/.test(text)) return 'Q3';
  if (/(恐れ|浄化|手放|流す|怖)/.test(text)) return 'Q4';
  if (/(情熱|空虚|燃え|集中|衝動)/.test(text)) return 'Q5';
  return 'Q1';
}

/* ---- 共鳴Qの既定ナレッジ ---- */
const DEFAULT_Q_HINT: Record<QCode, string> = {
  Q1: 'Q1＝金／秩序。整える力。過度に固くならないよう「余白」を作る。',
  Q2: 'Q2＝木／怒り・成長。伸びたい力が摩擦で苛立ちになりやすい。鍵は方向づけと「間」。',
  Q3: 'Q3＝土／不安・安定。土台づくり。小さなルーティンで重心を戻す。',
  Q4: 'Q4＝水／恐れ・浄化。手放しと流れ。呼吸と休息で巡りを回復。',
  Q5: 'Q5＝火／空虚・情熱。集中と点火。燃えすぎ注意、区切って進む。',
};

/* ====== 初回“Q診断”の整形 ====== */
type QProfile = { label: string; summary: string; tips: string[]; prompt: string; };
const Q_PROFILES: Record<QCode, QProfile> = {
  Q1: { label: '金（秩序）', summary: '整える力が前に出ています。', tips: ['情報を整理し、判断を遅らせる余白をつくる。','完璧主義の閾値を1段だけ下げる。'], prompt: '今日は何を手放すと軽くなりそう？' },
  Q2: { label: '木（成長）', summary: '伸びたい力が摩擦でいらだちに変わりやすい帯域。', tips: ['方向づけと「間」を少し多めに取る。','小さな前進で伸び感を切らさない。'], prompt: 'いま1歩だけ進めるとしたら、どこ？' },
  Q3: { label: '土（安定）', summary: '重心を戻す動きが必要。', tips: ['小さなルーティンを1つ固定。','栄養・睡眠・姿勢のどれかを底上げ。'], prompt: '毎日1分でできる土台の行為は？' },
  Q4: { label: '水（浄化）', summary: '溜め込みを流すタイミング。', tips: ['短い呼吸法or散歩で循環を回復。','不要なタスクを1つ閉じる。'], prompt: '今すぐ手放したい「ひとつ」は？' },
  Q5: { label: '火（情熱）', summary: '集中が点火しやすいが燃えすぎ注意。', tips: ['25分で区切る。','熱の行き先を1テーマに集約。'], prompt: '今日、火を灯したいテーマは？' },
};

function parseDateStr(s: string) { const m = s.match(/(\d{4})-(\d{2})-(\d{2})/); if (!m) return null; return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`); }
function diffDaysInclusive(a: Date, b: Date) { const ms = 24*60*60*1000; return Math.floor((b.getTime()-a.getTime())/ms)+1; }

/** ユーザー文の先頭にある「【Qコード総評】…」を読み取り、期間表示と注意書きを返す */
function extractSummaryContext(raw: string): { periodLabel?: string; mismatchNote?: string } {
  const mRange = raw.match(/【Qコード総評】\s*(\d{4}[-/]\d{2}[-/]\d{2})\s*[〜~\-–—]\s*(\d{4}[-/]\d{2}[-/]\d{2})/);
  const mTotal = raw.match(/合計\s*(\d+)\s*(日|件)/);
  if (!mRange) return {};
  const a = parseDateStr(mRange[1].replace(/\//g,'-'));
  const b = parseDateStr(mRange[2].replace(/\//g,'-'));
  if (!a || !b) return {};
  const days = diffDaysInclusive(a,b);
  const periodLabel = `直近${days}日（${mRange[1]} 〜 ${mRange[2]}）`;
  let mismatchNote: string | undefined;
  if (mTotal && mTotal[2] === '件') {
    const total = Number(mTotal[1] || 0);
    if (total > days * 3) mismatchNote = '※ 見出しの「合計○件」は記録“件数”の総和の可能性があります。本診断では期間を“日数”として解釈しています。';
  }
  return { periodLabel, mismatchNote };
}

function calcQConfidence(text: string, q: QCode) {
  const dict: Record<QCode, RegExp[]> = {
    Q1: [/整(う|える)|秩序|ルール|仕組み/],
    Q2: [/怒|苛|伸び|挑戦|焦り|成長/],
    Q3: [/不安|安定|土台|習慣|落ち着/],
    Q4: [/恐れ|怖|浄化|手放|流す|滞/],
    Q5: [/情熱|燃え|集中|衝動|没頭|空虚/],
  };
  const explicitBonus = /(?:^|[\s\p{P}])Q\s*([1-5])(?=$|[\s\p{P}])/u.test(text) ? 10 : 0;
  const hits = (dict[q] || []).reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
  return Math.min(95, 55 + hits * 12 + explicitBonus);
}

function extractSofiaClues(text: string, q: QCode): string[] {
  const T = (b: boolean, s: string) => (b ? s : '');
  const clues: string[] = [];
  clues.push(
    T(/(怒|苛|いらいら|フラストレーション)/.test(text), '💢 怒り・苛立ちの信号'),
    T(/(不安|心配|そわ|落ち着か)/.test(text), '😟 不安と落ち着き不足'),
    T(/(恐れ|怖|ビク|緊張)/.test(text), '😧 恐れ／緊張の高まり'),
    T(/(情熱|燃え|没頭|衝動)/.test(text), '🔥 情熱・没頭の偏り'),
  );
  clues.push(
    T(/(呼吸|息|浅い|深呼吸)/.test(text), '😮‍💨 呼吸の浅さ'),
    T(/(肩|首|こり|姿勢)/.test(text), '🧍 姿勢・肩首のこわばり'),
    T(/(睡眠|寝|疲れ|だる)/.test(text), '🛌 休息の質の低下'),
    T(/(食欲|胃|腹|栄養)/.test(text), '🥣 栄養リズムの乱れ'),
    T(/(停滞|空回り|迷い|優先|手が付)/.test(text), '🧭 優先順位の迷い'),
  );
  const qHints: Record<QCode, string[]> = {
    Q1: ['🗂️ ルール化が強め → 1段ゆるめる'],
    Q2: ['🌿 伸びたい方向を1つ決める', '⏱️ 「間」を3〜5分入れる'],
    Q3: ['🧱 小さな土台を固定（1分ルーティン）'],
    Q4: ['💧 手放し・後始末を1つ', '🚶 5分の散歩で循環'],
    Q5: ['🎯 焦点を1テーマに集約', '🔁 25分で区切る'],
  };
  clues.push(...qHints[q]);
  const uniq = Array.from(new Set(clues.filter(Boolean)));
  return uniq.slice(0, 4);
}

function firstDiagnosisBlock(q: QCode, text: string, ctx?: { periodLabel?: string; mismatchNote?: string }) {
  const p = Q_PROFILES[q];
  const conf = calcQConfidence(text, q);
  const color = Q_COLORS[q];
  const clues = extractSofiaClues(text, q);
  const extras: Record<QCode, { pitfalls: string[]; examples: string[]; micro: string[]; anchor: string[]; }> = {
    Q1: { pitfalls: ['枠に合わせるほど選択肢が縮む','「ちゃんと整ってからやる」に陥る'],
          examples: ['資料や設定の微修正が止まらない','未着手タスクを眺めて固まる'],
          micro: ['机上の可視範囲30cmだけ片づけ','タイマー3分で「いらない」判定'],
          anchor: ['朝のコーヒー前に1枚捨てる','PC起動時にデスクを一拭き'] },
    Q2: { pitfalls: ['勢いで広げ過ぎて散る','他者との摩擦でエネルギー漏れ'],
          examples: ['タスクを増やしすぎて未完が増える','言い返したくなって作業が止まる'],
          micro: ['3分でやる🌱「次の一歩」を1つ書く','作業前に深呼吸5回＋肩回し10秒'],
          anchor: ['開始前に「目的→手段→制限時間」を声に出す','ミーティング後に1分ログ'] },
    Q3: { pitfalls: ['準備に時間をかけすぎて本番が遅れる','変化が怖く停滞を選ぶ'],
          examples: ['ツール選定で無限比較','同じニュースをスクロールし続ける'],
          micro: ['1分ストレッチ＋1分呼吸＋1分メモ','就寝前に翌朝の最小ToDoを1行'],
          anchor: ['歯磨き後に1分家事','昼食後に5分散歩'] },
    Q4: { pitfalls: ['抱え込み過ぎて処理が滞る','完了条件を高くし過ぎて放置'],
          examples: ['未返信・未完了が頭の片隅で鳴り続ける','ファイル名や体裁で止まる'],
          micro: ['「不要1つ削除・保留1つ延期・完了1つ送信」','5分の片付け or 下書き送信'],
          anchor: ['ポモドーロの休憩でメール3通だけ処理','帰宅直後にバッグの中身を仕分け'] },
    Q5: { pitfalls: ['熱中→過集中→燃え尽き','成果が出ないと自己否定に傾く'],
          examples: ['夜更かしで翌日ガス欠','同時に複数プロジェクトへ着火'],
          micro: ['25分タイマー1セットだけ着火→5分で記録','SNSを15分ミュートして没頭'],
          anchor: ['開始前にBGM/香り/場所で点火儀式','終了時に1行ふりかえり'] },
  };

  const ex = extras[q];
  const lines: string[] = [
    '🧪 Q診断（初回）',
    '──────────',
    `代表: ${q} / ${p.label}　|　確度: ${conf}%　|　色相: ${color.base}×${color.mix}`,
  ];
  if (ctx?.periodLabel) { lines.push(ctx.periodLabel, ''); }

  lines.push(
    '【概況】',
    `・${p.summary}`,
    '・いまの文脈では、この帯域の特徴が前面に出ています。体内のリズム（睡眠・呼吸・姿勢）と、思考のリズム（優先順位・切り替え）を一度合わせると、余計なノイズが減り前進の手触りが戻りやすくなります。',
    '',
    '【状態の手がかり】',
    ...clues.map((c) => `・${c}`),
    '・該当するものがあれば、今日はそこだけ軽く整えるのが近道です。',
    '',
    '【よくある落とし穴】',
    ...ex.pitfalls.map((s) => `・${s}`),
    '',
    '【こういう時に揺れやすい】',
    ...ex.examples.map((s) => `・${s}`),
    '',
    '【扱い方ミニガイド】',
    ...p.tips.slice(0, 2).map((t) => `・${t}`),
    '・最初の10分は「整える／方向づけ／区切る」に集中。成果より“調律”を優先。',
    '',
    '【ミニ・ルーチン（3〜5分）】',
    ...ex.micro.map((s) => `・${s}`),
    '',
    '【アンカー（合図）】',
    ...ex.anchor.map((s) => `・${s}`),
    '',
    '【次の一歩】',
    `・${p.prompt}`,
    '・言葉にしてから着手すると、注意が散らず成功率が上がります。',
    '',
  );
  if (ctx?.mismatchNote) lines.push(ctx.mismatchNote);
  lines.push('✳️ Muメモ: 記録や文脈が少ない場合、この診断は暫定です。必要なら話しながら微調整しましょう。');
  return lines.join('\n');
}

/* ---------------- conv find-or-create ---------------- */
async function findOrCreateConversation(args: {
  userCode: string;
  reuseKey?: string | null;
  preferredTitle?: string | null;
  meta?: Record<string, any> | null;
}) {
  const { userCode, reuseKey, preferredTitle, meta } = args;
  const s = sb();

  if (reuseKey) {
    try {
      const { data, error } = await s
        .from('mu_conversations')
        .select('id')
        .eq('user_code', userCode)
        .eq('reuse_key', reuseKey)
        .limit(1)
        .maybeSingle();
      if (!error && data?.id) return { id: String(data.id), reused: true };
    } catch {
      dlog('[findOrCreateConversation] reuse_key lookup skipped (column missing?)');
    }
  }

  if (preferredTitle) {
    const { data, error } = await s
      .from('mu_conversations')
      .select('id')
      .eq('user_code', userCode)
      .eq('origin_app', 'mu')
      .eq('title', safeTitle(preferredTitle))
      .limit(1)
      .maybeSingle();
    if (!error && data?.id) return { id: String(data.id), reused: true };
  }

  const baseCommon = {
    user_code: userCode,
    title: safeTitle(preferredTitle || 'Mu 会話'),
    origin_app: 'mu',
    updated_at: nowIso(),
    last_turn_at: nowIso(),
  } as any;

  try {
    const { data, error } = await s
      .from('mu_conversations')
      .insert({ ...baseCommon, meta: meta ?? null, reuse_key: reuseKey ?? null })
      .select('id')
      .single();
    if (error) throw error;
    return { id: String(data!.id), reused: false };
  } catch (e: any) {
    dlog('[findOrCreateConversation] (a) failed:', e?.message || e);
  }

  try {
    const { data, error } = await s
      .from('mu_conversations')
      .insert({ ...baseCommon, reuse_key: reuseKey ?? null })
      .select('id')
      .single();
    if (error) throw error;
    return { id: String(data!.id), reused: false };
  } catch (e: any) {
    dlog('[findOrCreateConversation] (b) failed:', e?.message || e);
  }

  const { data, error } = await s.from('mu_conversations').insert(baseCommon).select('id').single();
  if (error) throw error;
  return { id: String(data!.id), reused: false };
}

/* ---------------- main handler ---------------- */
export async function POST(req: NextRequest) {
  const reqId = rid();
  const t0 = Date.now();
  dlog(`[muai.reply][${reqId}] START ${req.method} ${req.url}`);

  try {
    /* --- authz --- */
    const z0 = Date.now();
    const z: any = await verifyFirebaseAndAuthorize(req as any).catch((e: any) => {
      dlog(`[muai.reply][${reqId}] verify error`, e?.message ?? e);
      return { ok: false, allowed: false };
    });
    dlog(`[muai.reply][${reqId}] authorize ok=${!!(z?.ok && z?.allowed)} in ${Date.now() - z0}ms`);
    const userCode = (z?.userCode ?? z?.user_code) as string | undefined;
    if (!userCode) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    /* --- body --- */
    const body = await req.json().catch(() => ({}));
    const {
      conversationId,
      messages = [],
      text,
      agent = 'mu',
      reuse_key,
      title,
      mode = 'analysis',
      meta: extraMeta,
      kb, // { title?: string, content?: string, query?: string }
    } = body ?? {};

    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'text required' }, { status: 400 });
    }

    // === Q 推定（型安全） ===
    const explicitQRaw = extractQ(text);            // 例: "Q2" or ""
    const inferredQ = inferQFromText(text);         // ヒューリスティック
    const rawQ = (explicitQRaw || inferredQ) as unknown;
    const qCode: QCode = isQCode(rawQ) ? (rawQ as QCode) : 'Q3';
    const qColor = Q_COLORS[qCode];

    // === Knowledge（任意） ===
    const kbTitle: string | undefined = kb?.title?.toString?.();
    const kbContentRaw: string | undefined = kb?.content?.toString?.();
    const kbQuery: string | undefined = kb?.query?.toString?.();
    const kbContent = safeTrim(kbContentRaw ?? '', 2000);

    const effectiveReuseKey = (reuse_key as string | undefined) ?? (kbTitle ? `kb:${normalizeKey(kbTitle)}` : undefined);
    const shortForTitle = kbTitle ? safeTitle(`KB: ${kbTitle}`) : makeShortTitle(title ?? text ?? 'Q総評');
    const simplifiedDisplay = simplifyQSummaryDisplay(text);

    /* --- conversation 決定 --- */
    let convId = String(conversationId ?? '').trim();
    if (!convId) {
      const r = await findOrCreateConversation({
        userCode,
        reuseKey: effectiveReuseKey ?? null,
        preferredTitle: shortForTitle,
        meta: {
          ...(extraMeta ?? {}),
          mode,
          routed_from: 'muai',
          reuse_key: effectiveReuseKey ?? null,
          kb: kbTitle ? { title: kbTitle } : null,
        },
      });
      convId = r.id;
      dlog(`[muai.reply][${reqId}] convId=${convId} reused=${r.reused}`);
    }

    /* --- cookies (metrics only) --- */
    const ck = await cookies();
    const hasSb = !!ck.get('sb-hcodeoathneftqkmjyoh-auth-token')?.value;
    dlog(`[muai.reply][${reqId}] cookies hasSb=${hasSb}`);

    /* --- LLM 呼び出し --- */
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: 'OPENAI_API_KEY missing' }, { status: 500 });

    const normalizedHistory = Array.isArray(messages)
      ? messages.filter(Boolean).map((m: any) => {
          const raw = (m?.role ?? '').toString();
          const role = raw === 'bot' ? 'assistant'
            : raw === 'assistant' || raw === 'user' || raw === 'system' ? raw
            : 'user';
          return { role, content: m?.content?.toString?.() ?? String(m?.content ?? '') };
        })
      : [];

    const hasAssistantInHistory = normalizedHistory.some((m) => m.role === 'assistant');
    const isFirstTurn = normalizedHistory.length === 0 || !hasAssistantInHistory;

    const systemBase =
      'Reply in Japanese as Mu. Keep sentences short and kind.' +
      ' Use resonance vocabulary (Q1=金, Q2=木, Q3=土, Q4=水, Q5=火). ' +
      ' Never interpret Q2 as Quarter 2. ' +
      (isFirstTurn
        ? 'For the first response, return ONLY a compact diagnosis card in Sofia style: sections = 概況 / 状態の手がかり / 扱い方ミニガイド / 次の一歩. Do not echo knowledge text.'
        : 'For follow-up turns, answer conversationally in 3–5 short lines, ending with one question. Do not echo knowledge text.') +
      (kbContent
        ? ' If knowledge is provided, ground the answer in it and add a short citation at the end like: （出典: ナレッジ「<タイトル>」） for follow-up turns only.'
        : '');

    const kbSystem = kbContent
      ? `▼Knowledge (for grounding only; DO NOT echo)
【タイトル】${kbTitle ?? '（無題）'}
【内容】${kbContent}`
      : `▼Default Q hint (for grounding only; DO NOT echo)
${DEFAULT_Q_HINT[qCode]}`;

    const kbUserHint = kbQuery ? `（検索の意図）${kbQuery}` : null;

    const history = [
      { role: 'system' as const, content: systemBase },
      { role: 'system' as const, content: kbSystem },
      ...normalizedHistory,
      ...(kbUserHint ? [{ role: 'user' as const, content: kbUserHint }] : []),
      { role: 'user' as const, content: text },
    ];

    const p0 = Date.now();
    const llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mini', messages: history, temperature: 0.5 }),
    });
    dlog(`[muai.reply][${reqId}] LLM status=${llmRes.status} in ${Date.now() - p0}ms`);
    if (!llmRes.ok) {
      const errTxt = await llmRes.text().catch(() => '');
      console.error(`[muai.reply][${reqId}] LLM error`, errTxt?.slice(0, 400));
      return NextResponse.json({ error: 'llm_failed', detail: errTxt }, { status: 502 });
    }
    const data = await llmRes.json().catch(() => ({}));
    let llmText =
      data?.choices?.[0]?.message?.content?.toString?.() ??
      data?.choices?.[0]?.message?.content ??
      '';

    const banned = /(四半期|Quarter\s*2|Q2\s*=\s*第二四半期)/i;
    if (banned.test(llmText)) llmText = llmText.replace(banned, '（共鳴Q2の誤解は削除）');

    const shouldAppendCitation = !isFirstTurn && kbTitle && llmText && !/出典[:：]\s*ナレッジ/.test(llmText);
    if (shouldAppendCitation) llmText += `\n（出典: ナレッジ「${kbTitle}」）`;

    const summaryCtx = extractSummaryContext(text);
    const reply = isFirstTurn ? firstDiagnosisBlock(qCode, text, summaryCtx) : llmText;

    /* --- 保存（mu_conversations / mu_turns）--- */
    const s = sb();
    try {
      await s.from('mu_conversations').upsert(
        {
          id: convId,
          user_code: userCode,
          title: shortForTitle,
          origin_app: 'mu',
          updated_at: nowIso(),
          last_turn_at: nowIso(),
        },
        { onConflict: 'id' },
      );

      const tNow = Date.now();
      const uId = `ru-${tNow}-` + Math.random().toString(36).slice(2, 4);
      const aId = `ra-${tNow}-` + Math.random().toString(36).slice(2, 4);

      const userVisible = simplifiedDisplay ?? String(text);

      const insU = await s.from('mu_turns').insert({
        conv_id: convId,
        role: 'user',
        content: userVisible,
        meta: {
          source: 'muai',
          kind: 'user',
          mode,
          reuse_key: effectiveReuseKey ?? null,
          original_text: simplifiedDisplay ? String(text) : null,
          kb: kbTitle ? { title: kbTitle } : null,
        },
        used_credits: null,
        source_app: 'mu',
      });
      if (insU.error) dlog(`[muai.reply][${reqId}] insert user turn error`, insU.error);

      const insA = await s.from('mu_turns').insert({
        conv_id: convId,
        role: 'assistant',
        content: reply,
        meta: {
          provider: 'openai',
          model: 'gpt-5-mini',
          source: 'muai',
          mode,
          reuse_key: effectiveReuseKey ?? null,
          kb: kbTitle ? { title: kbTitle } : null,
          citations: shouldAppendCitation && kbTitle ? [{ type: 'knowledge', title: kbTitle }] : null,
          q: { code: qCode, color: qColor, stage: isFirstTurn ? 'S1' : 'S2' },
          first_diagnosis: isFirstTurn,
        },
        used_credits: null,
        source_app: 'mu',
      });
      if (insA.error) dlog(`[muai.reply][${reqId}] insert assistant turn error`, insA.error);

      /* --- Mu形式のレスポンス --- */
      const masterId = convId;
      const subId = aId;
      const charge = { amount: 0.5, aiId: 'mu', model: 'gpt-5-mini' };

      const out = {
        agent: 'Mu',
        reply,
        meta: {
          agent: 'Mu',
          source_type: 'chat',
          confidence: 0.6,
          phase: isFirstTurn ? 'Scan' : 'Inner',
          selfAcceptance: { score: 50, band: '40_70' },
          relation: { label: 'harmony', confidence: 0.6 },
          charge,
          master_id: masterId,
          sub_id: subId,
          thread_id: null,
          board_id: null,
          mu_prompt_version: 'mu.v2.5.0',
          mu_persona: 'base',
          mu_mode: isFirstTurn ? 'diagnosis' : 'normal',
          mu_tone: 'gentle_guide',
          mu_config_version: 'mu.config.v1.0.0',
          mu_prompt_hash: 'あなたは **Mu**。急かさず、短い文で、相手',
          knowledge_used: kbTitle ? [{ id: `kb:${normalizeKey(kbTitle)}`, title: kbTitle, score: 0.8 }] : [],
        },
        q: { code: qCode, stage: isFirstTurn ? 'S1' : 'S2', color: qColor },
        credit_balance: null,
        charge,
        master_id: masterId,
        sub_id: subId,
        conversation_id: masterId,
        title: safeTitle(shortForTitle || 'Mu 会話'),
      };

      dlog(`[muai.reply][${reqId}] DONE in ${Date.now() - t0}ms`);
      return NextResponse.json(out, { status: 200 });
    } catch (e) {
      dlog(`[muai.reply][${reqId}] persist thrown`, e);
      const masterId = convId;
      const subId = rid();
      const charge = { amount: 0.5, aiId: 'mu', model: 'gpt-5-mini' };
      return NextResponse.json(
        {
          agent: 'Mu',
          reply,
          meta: {
            agent: 'Mu',
            source_type: 'chat',
            confidence: 0.6,
            phase: 'Inner',
            selfAcceptance: { score: 50, band: '40_70' },
            relation: { label: 'harmony', confidence: 0.6 },
            charge,
            master_id: masterId,
            sub_id: subId,
            mu_prompt_version: 'mu.v2.5.0',
            mu_persona: 'base',
            mu_mode: 'normal',
            mu_tone: 'gentle_guide',
            mu_config_version: 'mu.config.v1.0.0',
            mu_prompt_hash: 'あなたは **Mu**。急かさず、短い文で、相手',
            knowledge_used: kbTitle ? [{ id: `kb:${normalizeKey(kbTitle)}`, title: kbTitle, score: 0.8 }] : [],
          },
          q: { code: qCode, stage: 'S1', color: qColor },
          credit_balance: null,
          charge,
          master_id: masterId,
          sub_id: subId,
          conversation_id: masterId,
          title: safeTitle(shortForTitle || 'Mu 会話'),
        },
        { status: 200 },
      );
    }
  } catch (e: any) {
    console.error(`[muai.reply][${rid()}] UNEXPECTED`, e?.stack || e?.message || e);
    return NextResponse.json({ error: 'unexpected', detail: e?.message ?? String(e) }, { status: 500 });
  }
}
