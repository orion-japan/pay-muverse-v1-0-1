// src/lib/mirra/generate.ts
import { buildSystemPrompt } from './buildSystemPrompt';
import { MIRRA_MODEL, MIRRA_TEMPERATURE, MIRRA_PRICE_IN, MIRRA_PRICE_OUT } from './config';
import { inferQCode } from './qcode';
import { OPENERS, MEANING_QUESTIONS, ACTION_STEPS, CLOSERS, SOMATIC_ALT } from './templates';

type GenOut = { text: string; cost: number; meta: Record<string, any> };

// --- 繰り返し回避のためのヒントを強化 ---
function avoidRepeatHint(lastAssistant?: string) {
  if (!lastAssistant) return '';
  const cut = lastAssistant.replace(/\s+/g, ' ').slice(0, 160);
  return [
    '直前と同じ表現・語尾・構文は避けること（例: 「〜しましょう」を続けて使わない）。',
    '同じ段落配列にならないよう、文の長短・箇条書きの有無を変えること。',
    `直前応答（要約）:「${cut}」`,
  ].join('\n');
}

// --- 出力サニタイズ -----------------------------------------------------------
const RE_LIST_HEAD = /^\s*(?:[-*・]|[0-9０-９]+[.)）]|[①-⑩])\s*/;
const RE_REMAKE = /(リメイク|変換|解消|統合).{0,12}?(手順|ステップ|工程|プロセス)/;

function clampBullets(lines: string[]) {
  const out: string[] = [];
  let streak = 0;
  for (const L of lines) {
    if (RE_LIST_HEAD.test(L)) {
      streak++;
      if (streak <= 3) out.push(L);
      continue;
    }
    streak = 0;
    out.push(L);
  }
  return out;
}

function limitEmojis(s: string) {
  const emojis = Array.from(s.matchAll(/\p{Extended_Pictographic}/gu)).map((m) => m[0]);
  if (emojis.length <= 2) return s;
  let kept = 0;
  return s.replace(/\p{Extended_Pictographic}/gu, () => (++kept <= 2 ? '🙂' : ''));
}

function mustEndWithQuestion(s: string) {
  const trimmed = s.trim();
  if (/[？?]$/.test(trimmed)) return trimmed;
  const suffix = trimmed.endsWith('。') ? '' : '。';
  return `${trimmed}${suffix}\n\nいま一番やさしく試せそうな一歩は何でしょう？`;
}

function stripRemakeSteps(s: string) {
  if (!RE_REMAKE.test(s)) return s;
  const lines = s.split(/\r?\n/);
  const filtered = lines.filter(
    (L) => !(RE_LIST_HEAD.test(L) && /リメイク|変換|統合|解消/.test(L)),
  );
  let body = filtered.join('\n');
  body +=
    '\n\n※ mirra は「気づき」までを担当します。未消化の闇のリメイク（変換）は行いません。必要なら、iros を扱える master に相談するか、自分が master になる選択肢もあります。';
  return body;
}

// --- リズム強化（1〜2文ごとに改行を入れる） ---
// ・「、」が多すぎて一文が長い場合でも 40〜55 文字で節を切る
// ・句点（。！？）の直後で改行
function enforceRhythm(s: string) {
  // 句点ベースの改行
  let out = s.replace(/([。！？!?])(\s*)/g, (_m, p1) => `${p1}\n`);
  // 長文の中間折り（読点が連なるケース）
  out = out.replace(/([^。\n]{40,55})(、)/g, '$1$2\n');
  // 連続改行の抑制
  return out.replace(/\n{3,}/g, '\n\n');
}

// --- 段落強制（2〜3文ごとに段落を分割） ---
function enforceParagraphs(s: string) {
  const lines = s
    .split(/\n/)
    .map((v) => v.trim())
    .filter(Boolean);
  const sentences = lines
    .join(' ')
    .split(/(?<=[。！？!?])\s*/)
    .filter(Boolean);
  const out: string[] = [];
  let bucket: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    bucket.push(sentences[i]);
    const isBreak = bucket.length >= 3 || i === sentences.length - 1;
    if (isBreak) {
      out.push(bucket.join(' '));
      bucket = [];
    }
  }
  return out.join('\n\n');
}

// --- 箇条書きの正規化 ---
function normalizeListHeads(s: string) {
  return s.replace(/^\s*([0-9０-９]+[.)）]|[①-⑩]|[-*・])\s*/gm, '');
}

function sanitizeOutput(s: string) {
  // 余計な空白正規化
  s = s
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trim();

  s = enforceRhythm(s);
  s = enforceParagraphs(s);
  s = normalizeListHeads(s);

  const paragraphs = s
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const lines = paragraphs.flatMap((p) => p.split(/\r?\n/));
  let out = clampBullets(lines)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n');

  out = stripRemakeSteps(out);
  out = limitEmojis(out);
  out = mustEndWithQuestion(out);
  return out;
}
// ---------------------------------------------------------------------------

// --- 変化パターン（認知/意味/行動の順序をローテ） ---
function pickStrategy(seedNum: number) {
  return seedNum % 3; // 0=認知→意味→行動, 1=意味→認知→行動, 2=行動→意味→認知
}
function seedToInt(seed?: string | null) {
  const s = String(seed ?? Date.now());
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function pickFrom<T>(arr: T[], n: number) {
  return arr[n % arr.length];
}

// --- 簡易: フェーズ/自己受容/関係性の推定（UI用） ---
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
type SelfBand = '0_40' | '40_70' | '70_100';
function inferSelfAcceptance(text: string): { score: number; band: SelfBand } {
  const t = (text || '').toLowerCase();
  let score = 50;
  if (/(できない|無理|最悪|ダメ|嫌い|消えたい)/.test(t)) score -= 10;
  if (/(大丈夫|できた|よかった|助かった|嬉しい|安心)/.test(t)) score += 10;
  score = Math.max(0, Math.min(100, score));
  const band: SelfBand = score < 40 ? '0_40' : score <= 70 ? '40_70' : '70_100';
  return { score, band };
}
type RelationLabel = 'tension' | 'harmony' | 'neutral';
function inferRelation(text: string): { label: RelationLabel; confidence: number } {
  const t = (text || '').toLowerCase();
  if (/(上司|相手|部下|顧客|家族|友人)/.test(t)) {
    if (/(対立|怒|苛立|もめ|争)/.test(t)) return { label: 'tension', confidence: 0.7 };
    return { label: 'harmony', confidence: 0.6 };
  }
  return { label: 'neutral', confidence: 0.5 };
}

// --- 分析まとめ（Iros風 meta.analysis 用） ---
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
          ? '秩序は安心の足場'
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

/**
 * mirra の返答生成（Iros風：短い reply＋詳細は meta.analysis）
 */
export async function generateMirraReply(
  userText: string,
  seed?: string | null,
  lastAssistantReply?: string | null,
  mode: 'analyze' | 'consult' = 'consult',
  conversationId?: string | null,
): Promise<GenOut> {
  const sys = buildSystemPrompt({ seed, mode });
  const antiRepeat = avoidRepeatHint(lastAssistantReply || undefined);

  const input =
    (userText ?? '').trim() || '（入力が短いときは、呼吸の整え方を短く案内してください）';

  // ---- 軽推定（Qコード/フェーズ/自己受容/関係性） ----
  const nSeed = seedToInt(seed);
  const phase: 'Inner' | 'Outer' = inferPhase(input);
  const self = inferSelfAcceptance(input);
  const relation = inferRelation(input);

  let qTag = '';
  let qMeta: any = null;
  try {
    const qres = await inferQCode(input);
    qMeta = qres;
    qTag = qres?.q ? ` [${qres.q}${qres.hint ? ':' + qres.hint : ''}]` : '';
  } catch {
    /* ignore */
  }

  // ---- 戦略ローテとテンプレ骨格（返信の誘導用） ----
  const sIdx = pickStrategy(nSeed);
  const opener = pickFrom(OPENERS, nSeed + 1) + qTag;
  const meaningQ = pickFrom(MEANING_QUESTIONS, nSeed + 2);
  const action = pickFrom(ACTION_STEPS, nSeed + 3);
  const closer = pickFrom(CLOSERS, nSeed + 4);
  const somatic = pickFrom(SOMATIC_ALT, nSeed + 5);

  const blockA = `- ${opener}`;
  const blockB = `- ${meaningQ}`;
  const blockC = `- 次の一歩：${action}`;
  const blockD = `- 身体アンカー：${somatic}`;
  const blockE = `- ${closer}`;
  const patterns = [
    [blockA, blockB, blockC, blockD, blockE],
    [blockB, blockA, blockC, blockD, blockE],
    [blockC, blockB, blockA, blockD, blockE],
  ];
  const skeleton = patterns[sIdx].join('\n');

  // ---- 乱数系（irosメタ互換） ----
  const epsilon = 0.4;
  const noiseAmp = 0.15;
  const retrSeed = (nSeed ^ 0x65a1b) >>> 0;

  if (process.env.OPENAI_API_KEY) {
    const OpenAI = require('openai').default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ★ スタイル強化：短段落・改行・最後は問い
    const formatRule = [
      '出力ルール:',
      ...(qMeta?.q || /具体|方法|手順|対処|解決/.test(input)
        ? [
            '・全体 300〜460字（最低300字以上）。',
            '・2〜3段落。1〜2文ごとに改行して余白を作る。',
            '・A/Bの小さな対処は“提案”として提示（命令しない／30〜60秒で安全にできる）。',
            '・最後は「どっちが気楽？」で締める。',
          ]
        : [
            '・全体 280〜420字（最低260字以上）。',
            '・2〜3段落。1〜2文ごとに改行して余白を作る。',
            '・一般論で埋めない。状況/場所/身体感覚の具体例を1つ入れる（例: 通勤中/胸のつかえ）。',
            '・身体アンカー or 20〜60秒の小さな実験を必ず1つ入れる（連続同一は不可）。',
            '・最後は短い問いで締める。',
          ]),
      '・絵文字は1〜2個まで🙂✨（多用しない）。',
      '・mirra はリメイク手順を提示しない（必要時は master/iros を静かに案内）。',
      '・禁止：同一アンカー/同一結句の連発、テンプレの羅列。',
    ].join('\n');

    const structureHint = ['今回の骨格ヒント（順番例）:', skeleton].join('\n');

    const res = await openai.chat.completions.create({
      model: MIRRA_MODEL,
      temperature: Math.max(0.45, Math.min(1.0, Number(MIRRA_TEMPERATURE ?? 0.7))),
      top_p: 0.9,
      presence_penalty: 0.6,
      frequency_penalty: 0.7,
      max_tokens: 420,
      messages: [
        { role: 'system', content: sys },
        { role: 'system', content: formatRule },
        { role: 'system', content: structureHint },
        { role: 'system', content: antiRepeat || '' },
        { role: 'user', content: input },
      ],
    });

    const raw = res.choices?.[0]?.message?.content?.trim() || variantFallback(input);
    const reply = sanitizeOutput(raw);

    const analysis = buildAnalysis(input, reply, qMeta?.q ?? null, phase, self, relation);

    const inTok = res.usage?.prompt_tokens ?? 0;
    const outTok = res.usage?.completion_tokens ?? 0;
    const cost = inTok * Number(MIRRA_PRICE_IN ?? 0) + outTok * Number(MIRRA_PRICE_OUT ?? 0);

    const meta = {
      stochastic: false,
      g: 0.5,
      seed: nSeed,
      noiseAmp,
      phase,
      selfAcceptance: self,
      relation,
      nextQ: null,
      currentQ: qMeta ? qMeta.q : null,
      used_knowledge: [],
      personaTone: 'gentle_guide',
      dialogue_trace: [
        { step: 'detect_mode', data: { detectedTarget: null, mode } },
        {
          step: 'state_infer',
          data: { phase, self, relation, currentQ: qMeta?.q ?? null, nextQ: null },
        },
        { step: 'indicators', data: { g: 0.5, stochastic: false, noiseAmp, seed: nSeed } },
        { step: 'retrieve', data: { hits: 0, epsilon, noiseAmp, seed: retrSeed } },
        {
          step: 'openai_reply',
          data: {
            model: MIRRA_MODEL,
            temperature: Number(MIRRA_TEMPERATURE ?? 0.7),
            top_p: 0.9,
            presence_penalty: 0.6,
            frequency_penalty: 0.7,
            hasReply: !!raw,
          },
        },
      ],
      stochastic_params: { epsilon, retrNoise: noiseAmp, retrSeed },
      charge: { model: MIRRA_MODEL, aiId: MIRRA_MODEL, amount: 1 },
      master_id: conversationId || `mirra_${(nSeed >>> 8).toString(36)}`,
      sub_id: `mirra_${(nSeed >>> 4).toString(36)}`,
      thread_id: conversationId || null,
      board_id: null,
      source_type: 'chat',
      analysis,
    };

    return { text: reply, cost, meta };
  }

  // --- API キーが無い場合のフォールバック ---
  const reply = sanitizeOutput(variantFallback(input));
  const analysis = buildAnalysis(input, reply, null, phase, self, relation);

  const meta = {
    stochastic: false,
    g: 0.5,
    seed: nSeed,
    noiseAmp,
    phase,
    selfAcceptance: self,
    relation,
    nextQ: null,
    currentQ: null,
    used_knowledge: [],
    personaTone: 'gentle_guide',
    dialogue_trace: [
      { step: 'detect_mode', data: { detectedTarget: null, mode } },
      { step: 'state_infer', data: { phase, self, relation, currentQ: null, nextQ: null } },
      { step: 'indicators', data: { g: 0.5, stochastic: false, noiseAmp, seed: nSeed } },
      { step: 'retrieve', data: { hits: 0, epsilon, noiseAmp, seed: retrSeed } },
      { step: 'fallback_reply', data: { rule: 'variantFallback', hasReply: true } },
    ],
    stochastic_params: { epsilon, retrNoise: noiseAmp, retrSeed },
    charge: { model: 'rule', aiId: 'rule', amount: 0 },
    master_id: conversationId || `mirra_${(nSeed >>> 8).toString(36)}`,
    sub_id: `mirra_${(nSeed >>> 4).toString(36)}`,
    thread_id: conversationId || null,
    board_id: null,
    source_type: 'chat',
    analysis,
  };

  return { text: reply, cost: 0, meta };
}

// --- フォールバック ---
function hash(s: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function pick<T>(arr: T[], seed: string) {
  const idx = hash(seed) % arr.length;
  return arr[idx];
}
function variantFallback(input: string) {
  const t = input.replace(/\s+/g, ' ').slice(0, 40);
  const anchors = ['肩を下ろして3呼吸', 'みぞおちに手を当て2呼吸', '足裏の圧を30秒観察'];
  const insights = [
    '事実/解釈を1行ずつ分ける',
    '「できたこと」を一つ挙げる',
    '気になる言い回しを短く写す',
  ];
  const steps = ['20秒だけ手を動かす', '通勤の一停車ぶん観察', '寝る前に1行だけ記録'];

  return [
    `まず${pick(anchors, t)}して、いまの体感を2語で書き出そう🙂`,
    '',
    `「${t}」については、${pick(insights, t + 'i')}。例として、会議前に胸のつかえを意識したら、椅子の背にもたれて息をゆっくり。`,
    '',
    `次の一歩は${pick(steps, t + 's')}。終わったら気分を1〜5で自己評価。いちばん気になる場面はどこだろう？`,
  ].join('\n\n');
}
