// src/lib/sofia/generate.ts
import { buildSofiaSystemPrompt } from './buildSystemPrompt';
// config の新旧どちらの書式でも読めるように、まとめて import
import * as CFG from './config';
import { inferQCode } from '@/lib/mirra/qcode';

/* Knowledge API 呼び出し（絶対URL化・dev/本番対応） */
async function kbSearch(query: string): Promise<{ title: string; content: string }[]> {
  try {
    let base = process.env.NEXT_PUBLIC_BASE_URL?.trim();
    if (!base) {
      const host = (process.env.NEXT_PUBLIC_VERCEL_URL || process.env.VERCEL_URL || '').trim();
      if (host) base = host.startsWith('http') ? host : `https://${host}`;
    }
    if (!base) base = `http://localhost:${process.env.PORT || 3000}`;

    const url = `${base}/api/knowledge/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return [];
    const js = await res.json();
    return js.items?.map((it: any) => ({ title: it.title, content: it.content })) ?? [];
  } catch {
    return [];
  }
}

/* 全角→半角 正規化 */
function toHalfWidth(s: string) {
  return (s || '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// --- kbTrigger: ここから丸ごと差し替え ---
function kbTrigger(text: string): string | null {
  const norm = (text || '')
    // 全角のQ→半角Q、全角英数→半角
    .replace(/Ｑ/g, 'Q')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .trim();

  // 1) Q1〜Q5 明示パターン
  const mQ = norm.match(/\bQ([1-5])\b/i);
  if (mQ?.[0]) return mQ[0].toUpperCase();

  // 2) 「◯◯ 知識ブース」「◯◯の知識ブース」などの直前語を抽出
  const mKB =
    norm.match(/([A-Za-z0-9一-龠ぁ-んァ-ヶー]+)\s*(?:の)?\s*知識ブース/) ||
    norm.match(/知識ブース\s*(?:で|を)?\s*([^、。!\? ]+)/);
  if (mKB?.[1]) return mKB[1];

  // 3) 主要ワードの単純含有
  const features = [
    'Qコード',
    'Self',
    'Vision',
    'Board',
    'iBoard',
    'QBoard',
    'Album',
    'Event',
    'Mirra',
    'Sofia',
    'Mu',
    'アプリ',
    'アプリケーション',
    '共鳴会', // ← 追加
  ];

  // 「◯◯とは/って」も拾う
  for (const k of features) {
    if (new RegExp(`${k}\\s*(とは|って)`).test(norm)) return k;
  }
  for (const k of features) {
    if (norm.includes(k)) return k;
  }
  return null;
}
// --- kbTrigger: ここまで ---

function kbFormat(entries: { title: string; content: string }[]): string {
  if (!entries.length) return '';
  return (
    '## Knowledge Booth\n' +
    entries
      .map(
        (e) =>
          `🌐 ${e.title} 知識ブース\n──────────────\n<br/>${e.content
            .split('\n')
            .map((line) => `・${line}`)
            .join('\n')}\n──────────────\n<br/>➡ 詳しい活用法や深い意味は共鳴会で。`,
      )
      .join('\n\n')
  );
}

type GenOut = { reply: string; meta: Record<string, any>; cost: number };

// ───────────────── 反復口調の抑制ヒント ─────────────────
function avoidRepeatHint(lastAssistant?: string) {
  if (!lastAssistant) return '';
  const cut = lastAssistant.replace(/\s+/g, ' ').slice(0, 160);
  return [
    '直前と同じ言い回しや語尾を繰り返さない（〜しましょう の連発NG）。',
    '文の長短・改行リズム・箇条書きの有無に変化を持たせる。',
    `直前応答（要約）:「${cut}」`,
  ].join('\n');
}

// ─────────────── リズム/余白/終止の軽サニタイズ ───────────────
function enforceRhythm(s: string) {
  return s.replace(/([^。！？!?]{15,40}[。！？!?])/g, '$1\n');
}

// 〆の一問を“共鳴確認”寄りに（核に落ちたかを測る）
const CHECK_ENDINGS = [
  'この捉え方、あなたの体感にどれくらい近いですか？',
  'いまの気づきを一言だけ自分の言葉で言い直すと？',
  'ここまでで腑に落ちた点と、まだ曖昧な点はどこでしょう？',
];
function mustEndWithQuestion(s: string) {
  const t = s.trim();
  if (/[？?]$/.test(t)) return t;
  const suf = t.endsWith('。') ? '' : '。';
  const q = CHECK_ENDINGS[(t.length + CHECK_ENDINGS.length) % CHECK_ENDINGS.length];
  return `${t}${suf}\n\n${q}`;
}
function sanitize(s: string) {
  return mustEndWithQuestion(enforceRhythm(s).replace(/\n{3,}/g, '\n\n'));
}

// ─────────────── 軽推定（phase/self/relation） ───────────────
type SelfBand = '0_40' | '40_70' | '70_100';
type RelationLabel = 'tension' | 'harmony' | 'neutral';

function inferPhase(text: string): 'Inner' | 'Outer' {
  const t = (text || '').toLowerCase();
  const innerKeys = ['気持ち', '感情', '不安', 'イライラ', '怖', '心', '胸', 'わたし', '私'];
  const outerKeys = ['上司', '相手', '会議', '職場', 'メール', 'チーム', '外部', '環境'];
  const innerHit = innerKeys.some((k) => t.includes(k));
  const outerHit = outerKeys.some((k) => t.includes(k));
  if (innerHit && !outerHit) return 'Inner';
  if (outerHit && !innerHit) return 'Outer';
  return 'Inner';
}
function inferSelfAcceptance(text: string): { score: number; band: SelfBand } {
  const t = (text || '').toLowerCase();
  let score = 50;
  if (/(できない|無理|最悪|ダメ|嫌い|消えたい)/.test(t)) score -= 10;
  if (/(大丈夫|できた|よかった|助かった|嬉しい|安心)/.test(t)) score += 10;
  score = Math.max(0, Math.min(100, score));
  const band: SelfBand = score < 40 ? '0_40' : score <= 70 ? '40_70' : '70_100';
  return { score, band };
}
function inferRelation(text: string): { label: RelationLabel; confidence: number } {
  const t = (text || '').toLowerCase();
  if (/(上司|相手|部下|顧客|家族|友人)/.test(t)) {
    if (/(対立|怒|苛立|もめ|争)/.test(t)) return { label: 'tension', confidence: 0.7 };
    return { label: 'harmony', confidence: 0.6 };
  }
  return { label: 'neutral', confidence: 0.5 };
}

// ─────────────── analysis（Iros 風） ───────────────
function buildAnalysis(
  input: string,
  reply: string,
  q: string | null,
  phase: 'Inner' | 'Outer',
  self: { score: number; band: SelfBand },
  relation: { label: RelationLabel; confidence: number },
) {
  const head = input.replace(/\s+/g, ' ').slice(0, 80);
  const qMap: Record<string, string> = {
    Q1: '秩序や境界がテーマ',
    Q2: '突破/怒りのエネルギーがテーマ',
    Q3: '安定欲求と不安のゆらぎがテーマ',
    Q4: '恐れや萎縮の解除がテーマ',
    Q5: '情熱と空虚感のバランスがテーマ',
  };
  const summary = `${head}${head.length === 80 ? '…' : ''}（${q && qMap[q] ? qMap[q] : '内省フェーズ'}）`;

  let background = '自己期待と現実のギャップによるストレス反応が考えられます。';
  if (q === 'Q1')
    background = '境界や手順への配慮が満たされず、苛立ちや詰まり感が生じている可能性。';
  if (q === 'Q2') background = '成長/裁量を妨げられた感覚が怒りとして表面化している可能性。';
  if (q === 'Q3') background = '不確実さや自己評価の揺らぎが不安として滞留している可能性。';
  if (q === 'Q4') background = '威圧/圧の記憶が再燃し、身体の萎縮が思考を狭めている可能性。';
  if (q === 'Q5') background = '意欲の火種が見えづらく、空虚を埋める行動に流れやすい可能性。';

  const tips = [
    '事実/解釈/願いを3行で分ける',
    '20〜60秒のミニ実験（呼吸・姿勢・1行メモ）',
    '「本当はどうあってほしい？」を1問だけ書く',
    '終わったら気分を1〜5で自己評価',
  ];

  const keyword =
    q === 'Q2'
      ? '境界が守られると怒りは方向性に変わる'
      : q === 'Q3'
        ? '小さな安定が次の一歩を呼ぶ'
        : q === 'Q1'
          ? '秩序は安心の基準'
          : q === 'Q4'
            ? '圧が抜けると呼吸が戻る'
            : '火種は小さくても前に進む';

  return {
    summary,
    background,
    tips,
    keyword,
    phase,
    selfAcceptance: self,
    relation,
    q,
  };
}

// ─────────────── 乱数（Iros 表示互換） ───────────────
function seedToInt(seed?: string | null) {
  const s = String(seed ?? Date.now());
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ─────────────── フォールバック ───────────────
function variantFallback(input: string) {
  const t = input.replace(/\s+/g, ' ').slice(0, 40);
  return `（fallback）${t}…\n\n深呼吸を3回して、いまの体感を2語でメモ。終わったら気分を1〜5でチェックしてみましょう。いま一番やさしく試せる一歩は何でしょう？`;
}

// ───────────────────── 本体 ─────────────────────
export async function generateSofiaReply(
  userText: string,
  seed?: string | null,
  lastAssistantReply?: string | null,
  mode: 'diagnosis' | 'consult' = 'diagnosis',
  conversationId?: string | null,
): Promise<GenOut> {
  const sys = buildSofiaSystemPrompt({});
  const antiRepeat = avoidRepeatHint(lastAssistantReply || undefined);
  const input = (userText ?? '').trim() || '（短文なら、呼吸を3回案内）';

  const nSeed = seedToInt(seed);
  const epsilon = 0.4;
  const noiseAmp = 0.15;
  const retrSeed = (nSeed ^ 0x65a1b) >>> 0;

  const phase: 'Inner' | 'Outer' = inferPhase(input);
  const self = inferSelfAcceptance(input);
  const relation = inferRelation(input);

  let qMeta: {
    q?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
    confidence?: number;
    hint?: string;
    color_hex?: string;
  } = {};
  try {
    qMeta = await inferQCode(input);
  } catch {}

  /* Knowledge 検索 */
  let kbBlock = '';
  let usedKnowledge: any[] = [];
  const trigger = kbTrigger(input);
  if (trigger) {
    const entries = await kbSearch(trigger);
    if (entries.length) {
      kbBlock = kbFormat(entries);
      usedKnowledge = entries;
    }
  }
  // Q表記のみ検出時の保険（全角/半角混在を拾う）
  if (!kbBlock && /[ＱQ][１-５1-5]/.test(input)) {
    const normQ =
      toHalfWidth(input)
        .replace(/Ｑ/g, 'Q')
        .match(/Q([1-5])/i)?.[0] ?? 'Q2';
    const entries2 = await kbSearch(normQ);
    if (entries2.length) {
      kbBlock = kbFormat(entries2);
      usedKnowledge = entries2;
    }
  }

  // ===== 設定の柔軟取得（新: SOFIA_AGENT / 旧: 個別定数） =====
  const sofiaAgent = (CFG as any).SOFIA_AGENT ?? {};
  const MODEL = sofiaAgent.model ?? (CFG as any).SOFIA_MODEL ?? 'gpt-5';
  const TEMP = Number(sofiaAgent.temperature ?? (CFG as any).SOFIA_TEMPERATURE ?? 0.6);
  const PRICE_IN = Number(sofiaAgent.price_in ?? (CFG as any).SOFIA_PRICE_IN ?? 0);
  const PRICE_OUT = Number(sofiaAgent.price_out ?? (CFG as any).SOFIA_PRICE_OUT ?? 0);

  // ===== ここを調整：段階説明は**必要時のみ**差し込む =====
  const wantsStory = /物語|ストーリー|語って|語り|闇|DNA|ＤＮＡ|リメイク/i.test(input);
  const stagedUnderstanding = wantsStory
    ? [
        '【段階ガイド】まず短く1段落で説明してください：',
        '1) 未消化の感情（闇）とは何か（身体に出る合図）。',
        '2) DNAから続く未消化の物語とは何か（系譜/土地の記憶としての比喩）。',
        '3) それをどうリメイクするか（意味の再配置）。',
        '説明のあとで必要に応じて物語化してよい。',
      ].join('\n')
    : '';

  // ===== 共鳴確認ルール（気づきの核） =====
  const resonanceCheckRule =
    '出力の最後は「共鳴の確認」の一問で締める（断定せず、腑に落ちたかを静かに確かめる）。';

  // ===== 安全統合フレーズ =====
  const safeBridge =
    '安全に、記憶と身体を統合して構造を更新してください。R層からC層へ、安全に橋を架けて統合してください。';

  // APIキー無し → フォールバック
  if (!process.env.OPENAI_API_KEY) {
    const reply = sanitize(variantFallback(input));
    const analysis = buildAnalysis(input, reply, qMeta.q ?? null, phase, self, relation);

    const meta = {
      stochastic: false,
      g: 0.5,
      seed: nSeed,
      noiseAmp,
      phase,
      selfAcceptance: self,
      relation,
      nextQ: null,
      currentQ: qMeta.q ?? null,
      used_knowledge: usedKnowledge,
      personaTone: 'gentle_guide',
      analysis,
      q_meta: qMeta,
      q: qMeta.q
        ? { code: qMeta.q, stage: 'S3', color: { base: 'Auto', hex: qMeta.color_hex ?? '#FFD54F' } }
        : undefined,
    };

    return { reply, meta, cost: 0 };
  }

  // OpenAI 呼び出し
  const OpenAI = require('openai').default;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 物語/通常で軽く長さを分岐（Sofiaのボリュームを安定化）
  const formatRule = [
    '出力ルール:',
    '・全体160〜260字、1〜2段落。1〜2文ごとに改行で余白。',
    '・絵文字は1〜2個🙂✨まで。',
    '・身体アンカー or 20〜60秒の小さな実験を必ず1つ入れる。',
    '・最後は短い問いで終える。',
  ].join('\n');

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system' as const, content: sys },
    { role: 'system' as const, content: formatRule },
    ...(stagedUnderstanding ? [{ role: 'system' as const, content: stagedUnderstanding }] : []),
    { role: 'system' as const, content: resonanceCheckRule },
    { role: 'system' as const, content: safeBridge },
    { role: 'system' as const, content: antiRepeat || '' },
  ];
  if (kbBlock) messages.push({ role: 'system', content: kbBlock });
  messages.push({ role: 'user', content: input });

  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: TEMP,
    top_p: 0.9,
    presence_penalty: 0.3,
    frequency_penalty: 0.12,
    max_tokens: 300,
    messages,
  });

  const raw = res.choices?.[0]?.message?.content?.trim() || variantFallback(input);
  const reply = sanitize(raw);

  const analysis = buildAnalysis(input, reply, qMeta.q ?? null, phase, self, relation);

  const inTok = res.usage?.prompt_tokens ?? 0;
  const outTok = res.usage?.completion_tokens ?? 0;
  const cost = inTok * PRICE_IN + outTok * PRICE_OUT;

  const meta = {
    stochastic: false,
    g: 0.5,
    seed: nSeed,
    noiseAmp,
    phase,
    selfAcceptance: self,
    relation,
    nextQ: null,
    currentQ: qMeta.q ?? null,
    used_knowledge: usedKnowledge,
    personaTone: 'gentle_guide',
    analysis,
    q_meta: qMeta,
    q: qMeta.q
      ? { code: qMeta.q, stage: 'S3', color: { base: 'Auto', hex: qMeta.color_hex ?? '#FFD54F' } }
      : undefined,
  };

  return { reply, meta, cost };
}
