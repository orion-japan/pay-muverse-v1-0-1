// src/lib/iros/language/flagshipSafeWriter.ts
// iros — FlagshipSafeWriter (LLM + flagshipGuard closed-loop)
//
// 目的：
// - seedText を「意味を変えずに」自然文へ整形する
// - flagshipGuard を通るまで再試行する（closed-loop）
// - scaffoldLike の must-have（purpose / one-point / points3）を “部分一致で保持” させる
//
// 注意：
// - mustHave を slice したり「原文のまま完全一致」要求をしない（矛盾を避ける）
// - LLMが @OBS 等の内部ラベルを本文に出さないように制約する
// - writer は “保険”。例外で落とさず seed に戻れるようにする

import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';
import { flagshipGuard, type FlagshipGuardContext } from '@/lib/iros/quality/flagshipGuard';

type GuardSlot = { key?: string; text?: string; content?: string; value?: string };

export type FlagshipSafeWriteArgs = {
  seedText: string;
  ctx?: FlagshipGuardContext | null;
  model?: string; // default: gpt-5
  maxRetries?: number; // default: 2
  trace?: { traceId?: string | null; conversationId?: string | null; userCode?: string | null };
};

export type FlagshipSafeWriteResult = {
  ok: boolean;
  text: string;
  verdict: ReturnType<typeof flagshipGuard>;
  tries: number;
};

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------
function norm(s: string) {
  return String(s ?? '').replace(/\r/g, '').trim();
}

function normLite(s: string) {
  return norm(s).replace(/[ \t]+/g, ' ').trim();
}

function toSlotText(s: GuardSlot | null | undefined): string {
  if (!s) return '';
  return String(s.text ?? s.content ?? s.value ?? '').trim();
}

function keyUpper(k: unknown) {
  return String(k ?? '').toUpperCase();
}

function uniq(arr: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    const t = normLite(x);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// scaffoldLike 判定（guard側と同系統）
// - ONE_POINT / POINTS_3 / PURPOSE / FLAG_ だらけ なら scaffoldLike
function isScaffoldLike(ctx?: FlagshipGuardContext | null): boolean {
  const slotKeys = Array.isArray(ctx?.slotKeys) ? ctx!.slotKeys!.map(String) : [];
  if (slotKeys.length === 0) return false;

  const hasOnePoint = slotKeys.some((k) => keyUpper(k).includes('ONE_POINT'));
  const hasPoints3 = slotKeys.some((k) => keyUpper(k).includes('POINTS_3'));
  const hasPurpose = slotKeys.some((k) => keyUpper(k).includes('PURPOSE'));
  const allFlag = slotKeys.every((k) => String(k).startsWith('FLAG_'));

  return hasOnePoint || hasPoints3 || hasPurpose || allFlag;
}

// must-have（部分一致でよい短い断片）を作る
// 重要：ここで “原文のまま完全一致” などを要求しない。
// guard側は needle（短縮）で見ているので、ここも短い断片に揃える。
function makeNeedle(raw: string, opts?: { min?: number; max?: number }) {
  const min = Math.max(6, Number(opts?.min ?? 10));
  const max = Math.min(80, Math.max(min, Number(opts?.max ?? 28)));

  const t = norm(raw)
    .replace(/[「」『』【】\[\]（）\(\)"'’‘]/g, '')
    .replace(/[、,。\.]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();

  if (!t) return null;
  if (t.length < min) return null;
  return t.slice(0, Math.min(max, t.length));
}

function pickMustHaveNeedles(ctx?: FlagshipGuardContext | null): string[] {
  if (!isScaffoldLike(ctx)) return [];

  const slots = Array.isArray(ctx?.slotsForGuard) ? (ctx!.slotsForGuard as GuardSlot[]) : [];
  const out: string[] = [];

  for (const s of slots) {
    const k = keyUpper(s?.key);
    const txt = toSlotText(s);
    if (!txt) continue;

    if (k.includes('PURPOSE') || k.includes('FLAG_PURPOSE')) {
      const first = norm(txt).split('\n').map((x) => x.trim()).filter(Boolean)[0] ?? '';
      const nd = makeNeedle(first, { min: 10, max: 28 });
      if (nd) out.push(nd);
      continue;
    }

    if (k.includes('ONE_POINT') || k.includes('FLAG_ONE_POINT')) {
      const first = norm(txt).split('\n').map((x) => x.trim()).filter(Boolean)[0] ?? '';
      const nd = makeNeedle(first, { min: 10, max: 28 });
      if (nd) out.push(nd);
      continue;
    }

    if (k.includes('POINTS_3') || k.includes('FLAG_POINTS_3')) {
      const lines = norm(txt)
        .split('\n')
        .map((x) => x.replace(/^\s*[-*•]\s+/, '').trim())
        .filter(Boolean)
        .slice(0, 3);

      for (const line of lines) {
        const nd = makeNeedle(line, { min: 8, max: 26 });
        if (nd) out.push(nd);
      }
      continue;
    }
  }

  return uniq(out).slice(0, 5); // 多すぎると逆に壊れるので上限
}

function buildSystem(phase: 'v1' | 'v2', mustHaveNeedles: string[]) {
  const base = [
    'あなたは iros の Writer。',
    '目的：与えられた素材の「意味」を変えずに、自然な日本語の短い段落へ整形する。',
    '',
    '【絶対制約】',
    '- 本文のみを出力する（ラベル/JSON/メタ記号/コード/装飾を出さない）。',
    '- 「@OBS」「@SHIFT」「@NEXT」など内部タグや、波括弧JSON（{...}）を本文に出さない。',
    '- 疑問符（? ？）を使わない。',
    '- 質問文（〜ですか/ますか/でしょうか/かな/教えて 等）を作らない。',
    '- 励ましテンプレ（大丈夫/素晴らしい/きっと/前向き/応援/焦らなくていい/少しずつ 等）を使わない。',
    '- ヘッジ（かもしれない/かもしれません/と思います/ように/できるかも 等）を使わない。',
    '- 一般論テンプレ（整理してみる/自然に/見えてくる/明確にする/〜してみる/可能性/感じがする 等）を避ける。',
    '- 箇条書き（- * • 1.）を使わない。',
    '',
    '【出力形】',
    '- 2〜4文。',
    '- 120〜220文字を目安（短すぎない）。',
    '- 素材の具体語を残す（最低2つ）。',
    '',
  ];

  const extra =
    phase === 'v2'
      ? [
          '【追加制約（再試行）】',
          '- 「場」「響き」「輪郭」「焦点」「視点」などの抽象ワードに逃げない。',
          '- 文末は断定寄りで終える（〜だ / 〜する / 〜になる）。',
          '- 同じ言い回しの反復を避ける。',
          '',
        ]
      : [];

  const mh =
    mustHaveNeedles.length > 0
      ? [
          '【must-have（部分一致で保持）】',
          '以下の断片（短いフレーズ）を、それぞれ本文に「そのまま」1回以上含める。',
          '※完全に同じ文字列でなくても、断片がそのまま含まれていればOK。',
          ...mustHaveNeedles.map((x) => `- ${x}`),
          '',
        ]
      : [];

  return [...base, ...extra, ...mh].join('\n');
}

function buildUser(seedText: string) {
  const s = seedText.trim();
  return [
    '【素材】',
    s,
    '',
    '上の素材の意味を保ったまま、制約に従って「本文だけ」を出力してください。',
  ].join('\n');
}

// ------------------------------------------------------------
// main
// ------------------------------------------------------------
export async function writeFlagshipSafeReply(
  args: FlagshipSafeWriteArgs,
): Promise<FlagshipSafeWriteResult> {
  const seedText = norm(args.seedText);
  // ctx が無い場合、safe-writer の採点は normalLite 扱いに固定する
  // （ctx=null だと strict 疑問推定が入り、短文でも QCOUNT_TOO_MANY 誤爆が起きる）
  const ctx = args.ctx ?? {
    slotKeys: ['SEED_TEXT', 'OBS', 'SHIFT'],
    slotsForGuard: null,
  };


  const model = args.model ?? 'gpt-5';
  const maxRetries = Math.max(0, Math.min(4, Number(args.maxRetries ?? 2)));

  const mustHaveNeedles = pickMustHaveNeedles(ctx);

  // 初期値：seedをそのまま返せるように
  let lastText = seedText;
  let lastVerdict = flagshipGuard(lastText, ctx);
  let tries = 0;

  for (let i = 0; i <= maxRetries; i++) {
    tries = i + 1;

    const phase: 'v1' | 'v2' = i === 0 ? 'v1' : 'v2';
    const sys = buildSystem(phase, mustHaveNeedles);
    const usr = buildUser(seedText);

    const messages: ChatMessage[] = [
      { role: 'system', content: sys },
      { role: 'user', content: usr },
    ];

    let out = '';
    try {
      const r = await chatComplete({
        purpose: 'writer',
        model,
        temperature: 0.2,
        responseFormat: 'text',
        messages,
        traceId: args.trace?.traceId ?? null,
        conversationId: args.trace?.conversationId ?? null,
        userCode: args.trace?.userCode ?? null,
      } as any);

      out = norm((r as any)?.text ?? (r as any)?.content ?? '');
    } catch {
      // writer は保険：落とさず次へ
      continue;
    }

    if (!out) continue;

    // guardで採点
    const v = flagshipGuard(out, ctx);
    lastText = out;
    lastVerdict = v;

    // OKで通す
    if (v.ok && v.level === 'OK') {
      return { ok: true, text: out, verdict: v, tries };
    }
  }

  // 失敗時：最後に生成できたもの（またはseed）を返す
  return { ok: false, text: lastText, verdict: lastVerdict, tries };
}
