// src/lib/iros/will/detectVentWill.ts
// iros — Vent/Will detector (minimal v1)
// - 感情吐露(Vent) と 前向き意志(Will) をスコア化して返す
// - continuity / qDecide / willEngine の“手前”で使う想定

export type VentWillResult = {
  ventScore: 0 | 1 | 2 | 3;
  willScore: 0 | 1 | 2 | 3;
  willTag: boolean; // 強い意志宣言（操縦席に戻った判定）
  reasons: {
    ventHits: string[];
    willHits: string[];
  };
};

type DictItem = { key: string; re: RegExp; w: number };

function clamp0to3(n: number): 0 | 1 | 2 | 3 {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n === 2) return 2;
  return 3;
}

function normalizeText(s: unknown): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .trim();
}

/* =========================================================
   Dictionaries (v1)
   - ここは運用しながら増やす
========================================================= */

// Vent（感情吐露）: 状態・不満・不安・焦り・自責・悪口
const VENT_DICT: DictItem[] = [
  { key: '悪口/攻撃', re: /(むかつく|ふざけるな|最悪|くそ|クソ|だるい|嫌い)/, w: 2 },
  { key: 'グチ/疲労', re: /(しんどい|つらい|疲れた|もう無理|やってられない)/, w: 2 },
  { key: '不安/焦り', re: /(間に合わない|焦る|心配|不安|怖い|こわい|詰まる|固まる)/, w: 2 },
  { key: '自責/絶望', re: /(自分がダメ|失敗した|終わった|どうせ)/, w: 2 },
  { key: '悩み', re: /(悩み|悩んで|困って|どうしたら)/, w: 1 },
];

// Will（前向き意志）: 掘る・特定・検証・整理・設計・実装・決める・指示
const WILL_DICT: DictItem[] = [
  { key: '深掘り/原因', re: /(掘る|深掘り|根だけ|原因|根本|特定|解明|検証|全容|決定的)/, w: 2 },
  { key: '整理/仕組み', re: /(整理|規則化|仕組み化|ルール化|体系化|守れる形|設計)/, w: 2 },
  { key: '実行/前進', re: /(やる|進める|決める|切り替える|選ぶ|実装|作る)/, w: 2 },
  { key: '方針/指示', re: /(〜で扱って|扱って|だけを|に絞る|受諾|一段下げて)/, w: 1 },
];

// 「意志が弱い」表現（願望・仮定）→ Willを少し減衰させる
const WEAK_WILL_HINT = /(できたら|できれば|したいな|できるといい|かも)/;

/* =========================================================
   API
========================================================= */

export function detectVentWill(text: unknown): VentWillResult {
  const t = normalizeText(text);
  if (!t) {
    return {
      ventScore: 0,
      willScore: 0,
      willTag: false,
      reasons: { ventHits: [], willHits: [] },
    };
  }

  let ventRaw = 0;
  let willRaw = 0;

  const ventHits: string[] = [];
  for (const item of VENT_DICT) {
    if (item.re.test(t)) {
      ventRaw += item.w;
      ventHits.push(item.key);
    }
  }

  const willHits: string[] = [];
  for (const item of WILL_DICT) {
    if (item.re.test(t)) {
      willRaw += item.w;
      willHits.push(item.key);
    }
  }

  // Willが“願望っぽい”時は少し弱める
  if (willRaw > 0 && WEAK_WILL_HINT.test(t)) {
    willRaw = Math.max(0, willRaw - 1);
  }

  // v1: 生スコアを 0..3 に丸める
  // 0:無し / 1:弱 / 2:中 / 3:強
  const ventScore = clamp0to3(ventRaw >= 5 ? 3 : ventRaw >= 3 ? 2 : ventRaw >= 1 ? 1 : 0);
  const willScore = clamp0to3(willRaw >= 5 ? 3 : willRaw >= 3 ? 2 : willRaw >= 1 ? 1 : 0);

  // willTag = 「操縦席に戻った」強い意志宣言
  // v1: willScore>=2 かつ「深掘り/原因」or「整理/仕組み」or「実行/前進」を含む
  const hasCoreWill =
    willHits.includes('深掘り/原因') || willHits.includes('整理/仕組み') || willHits.includes('実行/前進');

  const willTag = willScore >= 2 && hasCoreWill;

  return {
    ventScore,
    willScore,
    willTag,
    reasons: { ventHits, willHits },
  };
}
