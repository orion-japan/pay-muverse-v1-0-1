// src/lib/iros/icue/orchestratorIcue.ts
// iros — I-Cue Orchestrator (I層に“刺さる言い切り”を構造で生成)
//
// ねらい：
// - ユーザー入力に「I兆候（このままでは続かない／言い訳嫌悪／選ばない恐れ）」が含まれる時、
//   LLMに任せず “言い切り1文（iLine）” をここで確定する。
// - iLine は「説明」ではなく「言い切り」。
// - iLine は “ユーザーがすでに出している材料” だけで作る（新しい判断や助言を足さない）。
//
// 使い方（想定）
// 1) cue = detectICue(userText)
// 2) cue.ok のとき applyICueToSlotPlan(slots, cue) で slotPlan に注入
// 3) rephraseEngine では iLine を「改変禁止の固定文」として扱う（別対応）

export type ICueKind = 'NO_CHANGE_LIMIT' | 'EXCUSE_AVERSION' | 'UNCHOOSEN_FEAR';

export type ICue = {
  ok: boolean;
  kind: ICueKind | null;
  /**
   * I層の “言い切り1文”
   * - 禁止：〜なんですね / 〜のようです / 大切だと思います
   * - 推奨：本当に引っかかっているのは〜 / ここで一番つらいのは〜
   */
  iLine: string | null;

  /**
   * I層に入った後、会話を進める “問い” の候補（最大1つ）
   * - ここは「意図」という単語を使わず、価値/譲れなさ/生き方に触れる
   * - ただし iLine が刺さってから。刺さらない文脈では出さない。
   */
  iQuestion?: string | null;

  /**
   * デバッグ用（露出禁止）
   */
  debug?: {
    matched: string[];
    evidence: string[];
    score: number;
  };
};

export type DetectICueOptions = {
  /**
   * I層の言い切りに寄せる強さ（0〜2）
   * - 0: 穏やか（なるべく硬くしない）
   * - 1: 標準（おすすめ）
   * - 2: 強い（“失格”ラインの強制）
   */
  forceLevel?: 0 | 1 | 2;

  /**
   * 末尾句の固定（必要なら）
   */
  endPunct?: '。' | '…' | '';

  /**
   * iQuestion を付けるか
   */
  withQuestion?: boolean;
};

const DEFAULT_OPTS: Required<DetectICueOptions> = {
  forceLevel: 1,
  endPunct: '。',
  withQuestion: true,
};

export function detectICue(userText: string, opts: DetectICueOptions = {}): ICue {
  const o = { ...DEFAULT_OPTS, ...opts };
  const t = norm(userText);

  if (!t) return { ok: false, kind: null, iLine: null, iQuestion: null };

  // 兆候（強い順）
  const hits: { kind: ICueKind; phrase: string; ev: string }[] = [];

  // 1) 選ばない恐れ（I兆候として最強）
  if (hasAny(t, [
    '何も選ばなかった',
    '選ばなかった',
    '曖昧なまま',
    '決めないまま',
    '決めずに',
    'あとから一番つらい',
    '後で一番つらい',
  ])) {
    hits.push({ kind: 'UNCHOOSEN_FEAR', phrase: '選ばない恐れ', ev: pickEvidence(userText, ['何も選ばなかった', '曖昧', '決めない', '一番つらい']) });
  }

  // 2) 言い訳／正当化への嫌悪
  if (hasAny(t, [
    '言い訳',
    '誤魔化',
    'ごまか',
    '正当化',
    '自分に言い聞かせ',
    '仕方なかった',
    'タイミングじゃなかった',
    '理由を',
  ])) {
    hits.push({ kind: 'EXCUSE_AVERSION', phrase: '言い訳嫌悪', ev: pickEvidence(userText, ['言い訳', '誤魔化', '仕方なかった', '言い聞かせ', 'タイミング']) });
  }

  // 3) このままでは続かない感触（停滞の限界）
  if (hasAny(t, [
    'このまま',
    '限界',
    '良くなる実感',
    '時間だけが過ぎ',
    '変わらない',
    '留まっても',
    '外に出たい',
  ])) {
    // ただし「このまま」単体は弱いので、停滞語とセットでスコア
    const strong = hasAny(t, ['限界', '時間だけが過ぎ', '良くなる実感', '外に出たい']);
    if (strong || hits.length === 0) {
      hits.push({ kind: 'NO_CHANGE_LIMIT', phrase: '停滞の限界', ev: pickEvidence(userText, ['限界', '時間だけ', '良くなる実感', '留まっても', '外に出たい']) });
    }
  }

  if (hits.length === 0) {
    return { ok: false, kind: null, iLine: null, iQuestion: null, debug: { matched: [], evidence: [], score: 0 } };
  }

  // 優先順位（Iへ刺さる順）
  const picked = pickBest(hits);

  // iLine 生成（“言い切り”のみ）
  const iLine = buildILine(picked.kind, userText, o.forceLevel, o.endPunct);

  // iQuestion は “刺さった後の次” だけ。ここでは候補として返す。
  const iQuestion = o.withQuestion ? buildIQuestion(picked.kind, o.endPunct) : null;

  return {
    ok: true,
    kind: picked.kind,
    iLine,
    iQuestion,
    debug: {
      matched: hits.map((h) => `${h.kind}:${h.phrase}`),
      evidence: hits.map((h) => h.ev).filter(Boolean),
      score: scoreHits(hits),
    },
  };
}

/**
 * 「I層へ昇格」定義（運用ルール）
 * - detectICue().ok が true で、かつ iLine が空でないこと
 * - ここは “ユーザーの言葉” を材料にして、irosが言い切る（待たない）
 * - 以後のターンで「価値/譲れなさ」を扱う問い（iQuestion）を出す余地が生まれる
 */
export function isIUpgraded(cue: ICue): boolean {
  return !!cue?.ok && !!cue.iLine && cue.iLine.trim().length > 0;
}

// ─────────────────────────────────────────────────────────────
// Builders

function buildILine(kind: ICueKind, rawUserText: string, forceLevel: 0 | 1 | 2, end: '。' | '…' | ''): string {
  const u = rawUserText.replace(/\s+/g, ' ').trim();

  // できるだけ “ユーザーの語” を残す（要点だけ抽出）
  const hasShikatana = u.includes('仕方なかった');
  const hasIiwake = u.includes('言い訳') || u.includes('正当化') || u.includes('誤魔化') || u.includes('ごまか');
  const hasUnchosen = u.includes('何も選ばなかった') || u.includes('選ばなかった') || u.includes('曖昧');

  // 強さによって書式を変える（ただし “助言” は足さない）
  const prefix =
    forceLevel === 2
      ? 'ここで一番つらいのは'
      : forceLevel === 1
        ? '本当に引っかかっているのは'
        : 'いま引っかかっているのは';

  switch (kind) {
    case 'EXCUSE_AVERSION': {
      // 例：「仕方なかった」と言い聞かせ続ける自分
      if (hasShikatana) return `${prefix}、「仕方なかった」と自分に言い聞かせ続ける未来${end}`;
      if (hasIiwake) return `${prefix}、言い訳で自分を納得させ続ける自分になること${end}`;
      return `${prefix}、動かなかった理由を自分に積み上げていく感覚${end}`;
    }
    case 'UNCHOOSEN_FEAR': {
      if (hasUnchosen) return `${prefix}、“何も選ばなかった”まま残ること${end}`;
      return `${prefix}、選ばなかったことがあとから重く残る予感${end}`;
    }
    case 'NO_CHANGE_LIMIT': {
      return `${prefix}、このまま留まって時間だけが過ぎていく感覚${end}`;
    }
  }
}

function buildIQuestion(kind: ICueKind, end: '。' | '…' | ''): string {
  // “意図”は言わない。価値/譲れなさ/生き方へ。
  // ここは最大1問。短く。
  switch (kind) {
    case 'EXCUSE_AVERSION':
      return `「仕方なかった」で終わらせたくないのは、何を守りたいから${end}`;
    case 'UNCHOOSEN_FEAR':
      return `「選ぶ」を曖昧にしたくないのは、どこを自分の軸にしたいから${end}`;
    case 'NO_CHANGE_LIMIT':
      return `このままを終わらせるなら、次の場所で何だけは失いたくない${end}`;
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers

function pickBest(hits: { kind: ICueKind; phrase: string; ev: string }[]): { kind: ICueKind; phrase: string; ev: string } {
  // 優先：UNCHOOSEN_FEAR > EXCUSE_AVERSION > NO_CHANGE_LIMIT
  const order: Record<ICueKind, number> = {
    UNCHOOSEN_FEAR: 3,
    EXCUSE_AVERSION: 2,
    NO_CHANGE_LIMIT: 1,
  };
  return hits.slice().sort((a, b) => order[b.kind] - order[a.kind])[0];
}

function scoreHits(hits: { kind: ICueKind }[]): number {
  let s = 0;
  for (const h of hits) {
    if (h.kind === 'UNCHOOSEN_FEAR') s += 3;
    else if (h.kind === 'EXCUSE_AVERSION') s += 2;
    else s += 1;
  }
  return s;
}

function hasAny(t: string, needles: string[]): boolean {
  for (const n of needles) if (t.includes(norm(n))) return true;
  return false;
}

function pickEvidence(raw: string, hints: string[]): string {
  const r = raw.replace(/\n+/g, ' ').trim();
  for (const h of hints) {
    const idx = r.indexOf(h);
    if (idx >= 0) {
      const start = Math.max(0, idx - 12);
      const end = Math.min(r.length, idx + h.length + 12);
      return r.slice(start, end);
    }
  }
  return '';
}

function norm(s: string): string {
  return (s ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
