// app/api/agent/mui/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';
import { inferPhase } from '@/lib/mui/inferPhase';
import { estimateSelfAcceptance } from '@/lib/mui/estimateSelfAcceptance';
import { relationQualityFrom } from '@/lib/mui/relationQualityFrom';
import { nextQFrom } from '@/lib/mui/nextQFrom';
import { chargeOneTurn } from '@/lib/mui/charge';
import { retrieveKnowledge } from '@/lib/sofia/retrieve';

// ===== OpenAI =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

// ===== Config（env優先・既定値は gpt-4o）=====
const MODEL = (process.env.OPENAI_MODEL || 'gpt-4o').trim();
const TEMP  = Number(process.env.MIRRA_TEMPERATURE ?? process.env.IROS_TEMPERATURE ?? 0.8);
const TOP_P = Number(process.env.MIRRA_TOP_P ?? process.env.IROS_TOP_P ?? 0.95);
const FREQ  = Number(process.env.MIRRA_FREQ_PENALTY ?? process.env.IROS_FREQ_PENALTY ?? 0.2);
const PRES  = Number(process.env.MIRRA_PRES_PENALTY ?? process.env.IROS_PRES_PENALTY ?? 0.2);

// ナレッジ・リトリーブ（μ向けは軽め）
const RETRIEVE_LIMIT = 4;
const RETRIEVE_EPS   = Number(process.env.SOFIA_EPSILON ?? 0.3);
const RETRIEVE_NOISE = Number(process.env.SOFIA_NOISEAMP ?? 0.15);

// ===== 型 =====
type ChatRole = 'system' | 'user' | 'assistant';
type Msg = { role: ChatRole; content: string };

type MuiBody = {
  conversation_code?: string;
  messages?: Msg[];
  use_kb?: boolean;
  kb_limit?: number;
  model?: string;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  source_type?: string; // 'chat' | 'fshot' など
  vars?: any;

  // ▼ 追加（構造は壊さず optional）
  mode?: string;        // 'format_only' | 'coach_from_text' | 既定: 通常チャット
  text?: string;        // format_only / coach_from_text の入力本文
  instruction?: string; // format_only の追加指示（任意）
};

function json(data: any, init?: number | ResponseInit) {
  const status = typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;
  const headers = new Headers(typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-mu-user');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  return new NextResponse(JSON.stringify(data), { status, headers });
}
export async function OPTIONS() { return json({ ok: true }); }

const newConvCode = () => `MU-${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 5)}`;

function sbService() {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('Supabase env is missing');
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
}

function getLastUserText(messages: Msg[] | undefined | null) {
  if (!messages?.length) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return '';
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

// ---- dev fallback: userCode を取り出す（Cookie → Firebase → ヘッダ → クエリ の順）----
async function resolveUserCode(req: NextRequest) {
  // 0) Cookie 最優先（ログイン時に発行された実ユーザーコード）
  const cookieUser = req.cookies.get('mu_user_code')?.value?.trim();
  if (cookieUser) return { ok: true as const, userCode: cookieUser };

  // 1) Firebaseトークンが付与されている場合はそこから
  const z = await verifyFirebaseAndAuthorize(req);
  if (z.ok && z.allowed && z.userCode) return { ok: true as const, userCode: z.userCode };

  // 2) 本番は same-origin のヘッダ/クエリのみ許可、開発は無条件許可
  const hUser = req.headers.get('x-mu-user')?.trim();
  const qUser = req.nextUrl.searchParams.get('user_code')?.trim();
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev && (hUser || qUser)) return { ok: true as const, userCode: (hUser || qUser)! };

  const origin = req.headers.get('origin') || '';
  const host   = req.headers.get('host')   || '';
  const sameOrigin =
    !!origin && (origin.endsWith(host) || origin === `https://${host}` || origin === `http://${host}`);
  if (!isDev && sameOrigin && (hUser || qUser)) return { ok: true as const, userCode: (hUser || qUser)! };

  // 3) どれでも取れなければ 400
  return { ok: false as const, error: 'user_code required', status: 400 as const };
}

// ===== GET: ヘルス =====
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get('ping') === '1') {
    return json({ ok: true, service: 'Mui API', model: MODEL, now: new Date().toISOString() });
  }
  return json({ ok: true, service: 'Mui API' });
}

/** 返信のような文かをざっくり検知（format_onlyの安全弁） */
function isLikelyReply(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  return /^(了解|わかりました|それはいい考え|おすすめ|〜してみて|ですね|でしょう)/m.test(t);
}

/** OCR/粗整形の最小版（話者ラベルとページ見出しは保持） */
function simpleFormat(raw: string): string {
  const lines = String(raw ?? '').split(/\r?\n/);
  const out: string[] = [];
  const endOK = /[。！？!?…」』）)】]$/;

  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    if (/^【#\d+】$/.test(s)) { out.push(s); continue; }
    if (/^[AB] /.test(s)) { out.push(s); continue; }

    if (!out.length) { out.push(s); continue; }
    const prev = out[out.length - 1];
    if (!endOK.test(prev)) out[out.length - 1] = `${prev}${s.startsWith('、') ? '' : ' '}${s}`;
    else out.push(s);
  }
  return out.join('\n');
}

/** 日本語ポリッシュ（意味は変えない最終仕上げ／A/Bや【#1】維持） */
function polishJaKeepLabels(raw: string): string {
  let s = String(raw ?? '');

  // 空白・句読点
  s = s
    .replace(/[ \t]+/g, ' ')
    .replace(/\u3000/g, ' ')
    .replace(/\s*([。！？…、，,.!?])/g, '$1')
    .replace(/([「『（(【])\s+/g, '$1')
    .replace(/\s+([」』）)】])/g, '$1')
    .replace(/([ぁ-んァ-ヶ一-龥ー])\s+(?=[ぁ-んァ-ヶ一-龥ー])/g, '$1')
    .replace(/\?/g, '？');

  // 典型ノイズ
  s = s
    .replace(/おはよう、一?元気/g, 'おはよう、元気')
    .replace(/言っる/g, '言ってる')
    .replace(/クンょい/g, '')
    .replace(/会えそな/g, '会えな')
    .replace(/あぁあ+/g, 'あぁ')
    .replace(/一(?=元気)/g, '')
    .replace(/おはよ一/g, 'おはよー');

  // 余計な見出し語
  s = s
    .replace(/^【出力】\s*/gim, '')
    .replace(/^出力[:：]\s*/gim, '')
    .replace(/^整形結果[:：]\s*/gim, '');

  s = s.replace(/(\n){3,}/g, '\n\n').trim();
  return s;
}

// ===== POST: 生成・保存・課金 =====
export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return json({ error: 'OPENAI_API_KEY missing' }, 500);

    // 1) 認証 / userCode 解決
    const who = await resolveUserCode(req);
    if (!who.ok) return json({ error: who.error }, who.status);
    const userCode = who.userCode;

    // 2) body 正規化
    const raw = (await req.json().catch(() => ({}))) as MuiBody;
    const conversation_code =
      typeof raw.conversation_code === 'string' && raw.conversation_code.trim()
        ? raw.conversation_code.trim()
        : newConvCode();

    const messages = Array.isArray(raw.messages) ? raw.messages.slice(-50) : [];
    const use_kb = raw.use_kb !== false;
    const kb_limit = Number.isFinite(raw.kb_limit) ? Math.max(1, Math.min(8, Number(raw.kb_limit))) : RETRIEVE_LIMIT;

    const model = (raw.model || MODEL).trim();
    const temperature = typeof raw.temperature === 'number' ? raw.temperature : TEMP;
    const top_p = typeof raw.top_p === 'number' ? raw.top_p : TOP_P;
    const frequency_penalty = typeof raw.frequency_penalty === 'number' ? raw.frequency_penalty : FREQ;
    const presence_penalty  = typeof raw.presence_penalty  === 'number' ? raw.presence_penalty  : PRES;

    const source_type = raw.source_type || 'chat';
    const vars = raw.vars || {};

    // ========= format_only: 文章整形だけ（返信なし・非課金・未保存） =========
    if (raw.mode === 'format_only') {
      const targetText =
        (typeof raw.text === 'string' && raw.text.trim()) ||
        getLastUserText(messages) ||
        '';

      if (!targetText) return json({ ok: false, conversation_code, formatted: '' });

      const SYS_FMT = [
        'あなたは日本語の「整形器」です。意味や内容は一切改変せず、読みやすく直すだけに徹してください。',
        '要件：誤字の軽微修正、不要記号の除去、句読点整理、自然な改行。A/Bなどの話者ラベルや【#n】見出しは必ず保持。',
        'NG：追加の助言・要約・解釈・絵文字追加・追記文。出力は整形済み本文のみ。',
        (raw.instruction || '').trim(),
      ].filter(Boolean).join('\n');

      const payloadFmt = {
        model,
        messages: [
          { role: 'system', content: SYS_FMT },
          { role: 'user', content: targetText }
        ],
        temperature: Math.min(0.3, temperature),
        top_p,
        frequency_penalty: 0,
        presence_penalty: 0,
      };

      let formatted = '';
      const aiFmt = await callOpenAI(payloadFmt);
      if (aiFmt.ok) formatted = String(aiFmt.data?.choices?.[0]?.message?.content ?? '').trim();

      // 返答っぽい/空のときは安全に自前整形へフォールバック
      if (!formatted || isLikelyReply(formatted)) formatted = simpleFormat(targetText);

      // 最終ポリッシュ（意味は変えない／ラベル維持）
      formatted = polishJaKeepLabels(formatted);

      return json({ ok: true, conversation_code, formatted, mode: 'format_only' });
    }
    // ========= /format_only =========

    // ========= coach_from_text: 整形文を“最初の一手”に変換（課金・保存あり） =========
    if (raw.mode === 'coach_from_text') {
      const userText =
        (typeof raw.text === 'string' && raw.text.trim()) ||
        getLastUserText(messages) ||
        '';

      if (!userText) return json({ error: 'empty_text' }, 400);

      // ここではKBは使わず、テキスト内容に即した短い一手を返す
      const STYLE_RULES = `
## Style
- まず1文でやさしい共感。続けて要点を1文で言い換え。
- その後「次の一歩」を1つだけ：具体的アクション or 1つの確認質問（どちらか片方）。
- 長文禁止（合計 3〜6 行程度）。絵文字は使っても1つまで。
- 一般論の羅列や説教はしない。入力本文に具体的に紐づける。
`.trim();

      const SYS_COACH = [
        'あなたは恋愛スクショ相談「Mui」の会話パートナーです。以下はユーザーが整形した会話/メッセージ本文です。',
        'あなたは“最初の一手”だけ返します（短い共感→要点の再述→次の一歩）。',
        'アドバイスは1つまで、または確認質問は1つまで。両方は出さない。',
        '相手の尊厳と境界を守り、押し付けない提案にする。',
        STYLE_RULES,
      ].join('\n\n');

      const payloadCoach = {
        model,
        messages: [
          { role: 'system', content: SYS_COACH },
          { role: 'user', content: userText }
        ],
        temperature,
        top_p,
        frequency_penalty,
        presence_penalty,
      };

      const ai = await callOpenAI(payloadCoach);
      if (!ai.ok) return json({ error: 'Upstream error', status: ai.status, detail: ai.detail }, ai.status);
      const reply: string = ai.data?.choices?.[0]?.message?.content ?? '';

      // 課金（1ターン）
      const chargeRes = await chargeOneTurn({ userCode, amount: 1, meta: { agent: 'mui', model, mode: 'coach_from_text' } });
      if (!chargeRes.ok) {
        const err = 'error' in chargeRes ? chargeRes.error : 'charge_failed';
        const st  = 'status' in chargeRes && typeof chargeRes.status === 'number' ? chargeRes.status : 402;
        return json({ error: err }, st);
      }

      // 保存：整形本文を user 発話として保存 → 返信保存
      const sb = sbService();
      const now = new Date().toISOString();
      await sb.from('mu_turns').insert({
        conv_id: conversation_code,
        user_code: userCode,
        role: 'user',
        content: userText,
        meta: { source_type: 'coach_from_text' },
        used_credits: 0,
        source_app: 'mu',
        created_at: now,
      } as any);

      const phase = inferPhase(userText || '');
      const self  = estimateSelfAcceptance(userText || '');
      const relation = relationQualityFrom(phase, self.band);
      const turnMeta = {
        resonanceState: { phase, self, relation, currentQ: null, nextQ: null },
        used_knowledge: [],
        agent: 'mui',
        model,
        source_type: 'coach_from_text',
      };

      await sb.from('mu_turns').insert({
        conv_id: conversation_code,
        user_code: userCode,
        role: 'assistant',
        content: reply,
        meta: turnMeta as any,
        used_credits: 1,
        source_app: 'mu',
        created_at: now,
      } as any);

      return json({
        ok: true,
        conversation_code,
        reply,
        q: { code: 'Q2', stage: 'S1' },
        meta: { phase, self, relation },
        credit_balance: chargeRes.balance ?? null,
        mode: 'coach_from_text',
      });
    }
    // ========= /coach_from_text =========

    // ========= 従来の通常チャット（既存ロジック） =========
    const lastUser = getLastUserText(messages);
    const phase = inferPhase(lastUser || '');
    const self = estimateSelfAcceptance(lastUser || '');
    const relation = relationQualityFrom(phase, self.band);
    const currentQ = (vars as any)?.analysis?.qcodes?.[0]?.code ?? null;
    const nextQ = currentQ ? nextQFrom(currentQ, phase) : null;

    // 4) ナレッジ
    const seed = Math.abs(
      [...`${userCode}:${conversation_code}`].reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)
    );
    const kb = use_kb
      ? await retrieveKnowledge(
          (vars as any)?.analysis ?? { qcodes: [], layers: [], keywords: [] },
          kb_limit,
          lastUser,
          { epsilon: RETRIEVE_EPS, noiseAmp: RETRIEVE_NOISE, seed }
        ).catch(() => [])
      : [];

    const kbLines: string[] = [];
    if (use_kb && Array.isArray(kb) && kb.length) {
      kbLines.push('### Knowledge Base (retrieved)');
      for (let i = 0; i < Math.min(kb.length, kb_limit); i++) {
        const k: any = kb[i] ?? {};
        const t = String(k.title ?? `K${i + 1}`);
        const c = String(k.content ?? '').replace(/\s+/g, ' ').slice(0, 900);
        const u = k.url ? `\n- source: ${k.url}` : '';
        const tg = Array.isArray(k.tags) && k.tags.length ? `\n- tags: ${k.tags.join(', ')}` : '';
        kbLines.push(`- (${i + 1}) ${t}\n  ${c}${u}${tg}`);
      }
    }
    const kbBlock = kbLines.join('\n');

    // 5) System Prompt
    const STYLE_RULES = `
## Style
- 過度に断定せず、短めの段落で分かりやすく。
- 絵文字は多用せず1つまで。
- 色・共鳴のメタは最後に1行だけ添える（例: [Q:Q2 / Inner / harmony]).
`.trim();
    const SYS = [
      'あなたは恋愛スクショ相談「Mui」の会話パートナーです。短く温かく、実用的に返答します。',
      '相手の心理・相談者の自己肯定度をさりげなく踏まえ、押し付けない提案を1〜2個まで。',
      '不要な引用や前置きは避ける。',
      STYLE_RULES,
      use_kb && kbBlock ? '### Knowledge Use\n- 下の KB と一致する部分は活用し、弱い場合は一般知識で補う。' : '',
      use_kb && kbBlock ? kbBlock : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    // 6) OpenAI 呼び出し（まだ課金しない）
    const payload = {
      model,
      messages: [{ role: 'system', content: SYS }, ...messages],
      temperature,
      top_p,
      frequency_penalty,
      presence_penalty,
    };
    const ai = await callOpenAI(payload);
    if (!ai.ok) return json({ error: 'Upstream error', status: ai.status, detail: ai.detail }, ai.status);
    const reply: string = ai.data?.choices?.[0]?.message?.content ?? '';

    // 7) 課金（1ターン=1クレジット）
    const chargeRes = await chargeOneTurn({ userCode, amount: 1, meta: { agent: 'mui', model } });
    if (!chargeRes.ok) {
      const err = 'error' in chargeRes ? chargeRes.error : 'charge_failed';
      const st  = 'status' in chargeRes && typeof chargeRes.status === 'number' ? chargeRes.status : 402;
      return json({ error: err }, st);
    }

    // 8) DB 保存（mu_turns）
    const sb = sbService();
    const turnMeta = {
      resonanceState: { phase, self, relation, currentQ, nextQ },
      used_knowledge: Array.isArray(kb) ? kb.map((k: any, i: number) => ({ id: k.id, key: `K${i + 1}`, title: k.title })) : [],
      agent: 'mui',
      model,
      source_type,
    };

    const now = new Date().toISOString();
    const lastUserText = lastUser ?? '';

    if (lastUserText) {
      await sb.from('mu_turns').insert({
        conv_id: conversation_code,
        user_code: userCode,
        role: 'user',
        content: lastUserText,
        meta: { source_type },
        used_credits: 0,
        source_app: 'mu',
        created_at: now,
      } as any);
    }

    await sb.from('mu_turns').insert({
      conv_id: conversation_code,
      user_code: userCode,
      role: 'assistant',
      content: reply,
      meta: turnMeta as any,
      used_credits: 1,
      source_app: 'mu',
      created_at: now,
    } as any);

    // 9) Q/Stage 出力
    const qOut = (currentQ ?? nextQ ?? 'Q2') as 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

    return json({
      ok: true,
      conversation_code,
      reply,
      q: { code: qOut, stage: 'S1' },
      meta: { phase, self, relation },
      credit_balance: chargeRes.balance ?? null,
    });
  } catch (e: any) {
    console.error('[Mui API] Error:', e);
    return json({ error: 'Unhandled error', detail: String(e?.message ?? e) }, 500);
  }
}
