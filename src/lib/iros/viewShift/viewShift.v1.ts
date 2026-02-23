// src/lib/iros/viewShift/viewShift.v1.ts
// IROS ViewShift Engine v1 (pure function)
//
// 目的：
// - 「話題変更」ではなく「意識の重心移動」を検出する
// - 構造決定（depth/phase/lane/goal）には関与しない
// - 出力は “確認1行” の候補のみ（注入は上位レイヤーで行う）
//
// 重要：
// - sessionBreak === true のときは無効（確認文を出さない）
// - 単一シグナルでは判定しない（複合スコア >= 2 で候補）

export type ETurnV1 = 'e1' | 'e2' | 'e3' | 'e4' | 'e5';

export type ViewShiftVariant = 'tempo' | 'basic' | 'presence' | 'branch';

export type ViewShiftDecision = {
  ok: boolean;
  score: number;
  variant: ViewShiftVariant | null;
  confirmLine: string | null;

  // デバッグ用（本文に出さない前提）
  reasons: string[];
  evidence: {
    depthChanged: boolean;
    eDeltaAbs1: boolean;
    topicClusterChanged: boolean;
    abstractRateUp: boolean;
    prev: {
      depthHead: string | null;
      e_turn: ETurnV1 | null;
      topicClusterKey: string | null;
      abstractRate: number | null;
    };
    now: {
      depthHead: string | null;
      e_turn: ETurnV1 | null;
      topicClusterKey: string | null;
      abstractRate: number | null;
    };
    sessionBreak: boolean | null;
  };
};

export type ViewShiftInput = {
  // 現在ターン
  userText: string;
  depth: string | null; // 'R3' など
  e_turn: ETurnV1 | null;
  sessionBreak: boolean | null;

  // 前回ターン（保存しておくスナップショット）
  prev: {
    depth: string | null;
    e_turn: ETurnV1 | null;
    topicClusterKey: string | null;
    abstractRate: number | null;
  } | null;
};

const E_NUM: Record<ETurnV1, number> = { e1: 1, e2: 2, e3: 3, e4: 4, e5: 5 };

function depthHead(depth: string | null): string | null {
  const d = String(depth ?? '').trim();
  if (!d) return null;
  const h = d[0] ?? '';
  return h ? h : null;
}

// ざっくり「抽象語」を数える（NLPなしで安全側）
// - 「こと/もの/感じ/状態/意味/意図/方向/全体/本質/可能性/未来/自分/人生」など
const ABSTRACT_RE =
  /(こと|もの|感じ|感覚|状態|意味|意図|方向|全体|本質|可能性|未来|自分|人生|価値|観点|視点|在り方|抽象|構造)/g;

// ざっくり「焦点語クラスタ」を作る（安全：単語分かち書き無し）
// - 日本語は分かちが無いので、まずは “候補語” を抽出してキー化
// - 長めのカタカナ/英字/数字/漢字の連なりを拾う
function buildTopicClusterKey(text0: string): string | null {
  const text = String(text0 ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // 候補語：漢字2+ / カタカナ3+ / 英字3+ / 数字（連続）
  const tokens: string[] = [];

  const kanji = text.match(/[一-龠]{2,}/g) ?? [];
  const kata = text.match(/[ァ-ヶー]{3,}/g) ?? [];
  const latin = text.match(/[A-Za-z]{3,}/g) ?? [];
  const num = text.match(/[0-9]{2,}/g) ?? [];

  for (const arr of [kanji, kata, latin, num]) {
    for (const t of arr) {
      const v = String(t).trim();
      if (!v) continue;
      // ありがちなノイズを除外（最小）
      if (v === 'Iros' || v === 'IROS') continue;
      tokens.push(v);
    }
  }

  if (tokens.length === 0) return null;

  // 上位を安定化：重複除去→長い順→最大8個→'|'で結合
  const uniq = Array.from(new Set(tokens));
  uniq.sort((a, b) => b.length - a.length);

  const top = uniq.slice(0, 8);
  const key = top.join('|').slice(0, 256);
  return key.length > 0 ? key : null;
}

function abstractRate(text0: string): number | null {
  const t = String(text0 ?? '').trim();
  if (!t) return null;

  // 文字数ベースで過度に偏らないよう “文節っぽい数” を近似
  // - 句読点/スペース/改行/記号で分割し、要素数を分母にする
  const parts = t
    .split(/[。、．，\n\r\t ]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const denom = Math.max(1, parts.length);
  const hits = (t.match(ABSTRACT_RE) ?? []).length;
  return hits / denom;
}

function topicClusterChanged(prevKey: string | null, nowKey: string | null): boolean {
  // どちらかが無いなら「変化」とは断定しない（安全側：false）
  if (!prevKey || !nowKey) return false;

  if (prevKey === nowKey) return false;

  // Jaccard 的に “かなり違う” を 1 で判定（簡易）
  const a = new Set(prevKey.split('|').filter(Boolean));
  const b = new Set(nowKey.split('|').filter(Boolean));
  const inter = Array.from(a).filter((x) => b.has(x)).length;
  const union = new Set([...Array.from(a), ...Array.from(b)]).size;
  const sim = union > 0 ? inter / union : 1;

  // 共通が薄い＝焦点が変わった可能性（閾値は保守的に）
  return sim <= 0.25;
}

export function computeViewShiftV1(input: ViewShiftInput): ViewShiftDecision {
  const reasons: string[] = [];

  const sessionBreak = input.sessionBreak ?? null;
  if (sessionBreak === true) {
    return {
      ok: false,
      score: 0,
      variant: null,
      confirmLine: null,
      reasons: ['sessionBreak=true => disabled'],
      evidence: {
        depthChanged: false,
        eDeltaAbs1: false,
        topicClusterChanged: false,
        abstractRateUp: false,
        prev: {
          depthHead: depthHead(input.prev?.depth ?? null),
          e_turn: input.prev?.e_turn ?? null,
          topicClusterKey: input.prev?.topicClusterKey ?? null,
          abstractRate: input.prev?.abstractRate ?? null,
        },
        now: {
          depthHead: depthHead(input.depth ?? null),
          e_turn: input.e_turn ?? null,
          topicClusterKey: buildTopicClusterKey(input.userText),
          abstractRate: abstractRate(input.userText),
        },
        sessionBreak,
      },
    };
  }

  const prev = input.prev ?? null;

  const prevDepthHead = depthHead(prev?.depth ?? null);
  const nowDepthHead = depthHead(input.depth ?? null);

  const depthChanged =
    !!prevDepthHead && !!nowDepthHead && prevDepthHead !== nowDepthHead;

  const prevE = prev?.e_turn ?? null;
  const nowE = input.e_turn ?? null;
  const eDeltaAbs1 =
    !!prevE && !!nowE ? Math.abs(E_NUM[nowE] - E_NUM[prevE]) >= 1 : false;

  const nowTopicKey = buildTopicClusterKey(input.userText);
  const prevTopicKey = prev?.topicClusterKey ?? null;
  const tChanged = topicClusterChanged(prevTopicKey, nowTopicKey);

  const prevAbs = typeof prev?.abstractRate === 'number' ? prev.abstractRate : null;
  const nowAbs = abstractRate(input.userText);
  // “上昇”は少しだけ保守的に（誤爆を避ける）
  const abstractRateUp =
    prevAbs != null && nowAbs != null ? nowAbs - prevAbs >= 0.35 : false;

  let score = 0;
  if (depthChanged) {
    score += 1;
    reasons.push('depthHead changed');
  }
  if (eDeltaAbs1) {
    score += 1;
    reasons.push('abs(e_delta) >= 1');
  }
  if (tChanged) {
    score += 1;
    reasons.push('topicCluster changed');
  }
  if (abstractRateUp) {
    score += 1;
    reasons.push('abstractRate up');
  }

  const ok = score >= 2;

  let variant: ViewShiftVariant | null = null;
  if (ok) {
    const eDelta =
      prevE && nowE ? Math.abs(E_NUM[nowE] - E_NUM[prevE]) : 0;

    // 強揺れ：score>=4 か、e±2 + depth変化
    if (score >= 4 || (eDelta >= 2 && depthChanged)) {
      variant = 'branch';
    } else if (score === 3) {
      variant = 'presence';
    } else {
      // score === 2
      // “軽い揺れ(tempo)”：depthもtopicも動いていないのに、eと抽象度だけが動いた等
      // => 断定を避け、テンポ短い確認に落とす
      const lightTempo = !depthChanged && !tChanged;
      variant = lightTempo ? 'tempo' : 'basic';
    }
  }

  const confirmLine = (() => {
    if (!ok || !variant) return null;
    if (variant === 'tempo') return '前の続きで進めますか？';
    if (variant === 'basic') return '前の話の続きで進めてよいですか？';
    if (variant === 'presence')
      return '少し方向が動いた感じがあります。前の話の続きで進めてよいですか？';
    // branch
    return '前の話の続きで進めてよいですか？ 別の話に切り替える場合は教えてください。';
  })();

  return {
    ok,
    score,
    variant,
    confirmLine,
    reasons,
    evidence: {
      depthChanged,
      eDeltaAbs1,
      topicClusterChanged: tChanged,
      abstractRateUp,
      prev: {
        depthHead: prevDepthHead,
        e_turn: prevE,
        topicClusterKey: prevTopicKey,
        abstractRate: prevAbs,
      },
      now: {
        depthHead: nowDepthHead,
        e_turn: nowE,
        topicClusterKey: nowTopicKey,
        abstractRate: nowAbs,
      },
      sessionBreak,
    },
  };
}

// 上位レイヤーが「前回スナップショット」を保存するためのヘルパー
export function buildViewShiftSnapshot(args: {
  userText: string;
  depth: string | null;
  e_turn: ETurnV1 | null;
}): { depth: string | null; e_turn: ETurnV1 | null; topicClusterKey: string | null; abstractRate: number | null } {
  return {
    depth: args.depth ?? null,
    e_turn: args.e_turn ?? null,
    topicClusterKey: buildTopicClusterKey(args.userText),
    abstractRate: abstractRate(args.userText),
  };
}
