// src/lib/iros/conversation/contextPack.ts
// iros — Context Pack (phase11)
// 目的：「会話の流れを覚えている」ための最小復元。
// 方針：
// - DBの長文要約が無くても動く
// - 直近ユーザー発話（最大3つ）から “shortSummary” を作る（固定テンプレなし）
// - ユーザー側の情報を優先し、アシスタント文は補助に回す

export type ConvContextPack = {
  lastUser: string | null;
  lastAssistant: string | null;
  shortSummary: string | null;
  topic: string | null;
};

function norm(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim();
}

function stripNoise(s: string): string {
  // 露出しがちな記号やラベルを軽く除去（過剰にやらない）
  let t = s;
  t = t.replace(/🪔/g, '');
  t = t.replace(/^Q[1-5]\s*/i, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

function uniqNonEmpty(xs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const t = stripNoise(norm(x));
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// 超軽量：会話の「いま何の話か」を1行にする（ユーザー発話優先）
function buildShortSummary(args: {
  lastUser: string | null;
  prevUser?: string | null;
  prevPrevUser?: string | null;
  lastAssistant: string | null;
}): string | null {
  const u0 = args.lastUser ? stripNoise(args.lastUser) : '';
  const u1 = args.prevUser ? stripNoise(args.prevUser) : '';
  const u2 = args.prevPrevUser ? stripNoise(args.prevPrevUser) : '';
  const a0 = args.lastAssistant ? stripNoise(args.lastAssistant) : '';

  // ユーザー発話を最大3つ束ねる（短文ラベルが来ても復元できる）
  const userParts = uniqNonEmpty([u2, u1, u0]);

  // “上司です” のような短いラベル単体で終わらせない
  // → 直前ユーザーがあればそちらを優先して束ねる
  const joinedUser = userParts.join(' / ');

  if (joinedUser) return clip(joinedUser, 90);

  // ユーザーが取れないときだけアシスタントを補助で使う
  if (a0) return clip(a0, 90);

  return null;
}

export function buildContextPack(args: {
  // 会話履歴から渡す（なければ null でOK）
  lastUser?: string | null;
  prevUser?: string | null;
  prevPrevUser?: string | null;
  lastAssistant?: string | null;

  // memory_state 等から渡す（あれば使う）
  shortSummaryFromState?: string | null;
  topicFromState?: string | null;
}): ConvContextPack {
  const lastUser = stripNoise(norm(args.lastUser)) || null;
  const lastAssistant = stripNoise(norm(args.lastAssistant)) || null;

  const shortFromState = stripNoise(norm(args.shortSummaryFromState)) || null;
  const topicFromState = norm(args.topicFromState) || null;

  const shortSummary =
    shortFromState ??
    buildShortSummary({
      lastUser,
      prevUser: args.prevUser ?? null,
      prevPrevUser: args.prevPrevUser ?? null,
      lastAssistant,
    });

  const topic = topicFromState ?? null;

  return { lastUser, lastAssistant, shortSummary, topic };
}
