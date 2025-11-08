// /src/lib/iros/focusCore.ts
// Minimal, dependency-free focus analyzer used by Iros.
// 他ファイルに型が無くても単体でビルドできるよう union 型を内包しています。

/* ========= Types ========= */
export type Phase = 'Inner' | 'Outer';
export type Depth =
  | 'S1' | 'S2' | 'S3'
  | 'R1' | 'R2' | 'R3'
  | 'C1' | 'C2' | 'C3'
  | 'I1' | 'I2' | 'I3';

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export interface FocusResult {
  phase: Phase;
  depth: Depth;
  q: QCode;
  qName: string;
  qConf: number;               // 0.0 - 1.0 (confidence)
  domain: 'core' | 'work' | 'life' | 'love' | 'health' | 'unknown';
  protectedFocus: string;      // その会話で「守っている核」
  anchors: string[];           // キーワードアンカー
  action: string;              // 次の最小アクション（説明文）
}

/* ========= Heuristics ========= */

const JA_WS = /[\s\u3000]+/g;

const Q_RULES: Array<{code: QCode; name: string; re: RegExp}> = [
  { code: 'Q2', name: '怒り/成長',  re: /(怒|苛|ムカ|成長|挑戦|進化|前進)/ },
  { code: 'Q5', name: '空虚/情熱',  re: /(情熱|燃える|ワクワク|空虚|虚無|やる気)/ },
  { code: 'Q4', name: '恐れ/浄化',  re: /(怖|恐|不安定|浄化|手放|デトックス)/ },
  { code: 'Q3', name: '不安/安定',  re: /(不安|心配|迷|揺|落ち着|安心|安定)/ },
  { code: 'Q1', name: '我慢/秩序',  re: /(我慢|責任|規律|秩序|締切|ルール|管理)/ },
];

function guessQ(text: string): { q: QCode; qName: string; conf: number } {
  let best: { q: QCode; qName: string; conf: number } = { q: 'Q1', qName: '秩序', conf: 0.4 };
  for (const r of Q_RULES) {
    const hit = text.match(r.re)?.length ?? 0;
    if (hit > 0) {
      const conf = Math.min(0.9, 0.45 + hit * 0.2);
      if (conf > best.conf) best = { q: r.code, qName: r.name, conf };
    }
  }
  return best;
}

function guessPhase(text: string): Phase {
  const inner = /(私は|わたし|内面|心|気持ち|本音|自己|内省|疲れ|つらい|怖い)/;
  const outer = /(相手|他者|会社|上司|顧客|売上|数値|投稿|発信|ミーティング|連絡|提案|実装|進捗)/;
  if (inner.test(text) && !outer.test(text)) return 'Inner';
  if (outer.test(text) && !inner.test(text)) return 'Outer';
  // tie-breaker by presence of first-person
  return /私|わたし/.test(text) ? 'Inner' : 'Outer';
}

function guessDepth(text: string): Depth {
  // とても簡易な段階割当：キーワード密度で S→R→C→I を推定
  const s = /(気持ち|整理|現状|観測|内省|受容)/g;
  const r = /(関係|対話|共鳴|チーム|家族|顧客|相手)/g;
  const c = /(作る|実装|投稿|設計|構築|リリース|出す|書く)/g;
  const i = /(意図|目的|存在|意味|ビジョン|使命|核)/g;

  const score = (re: RegExp) => (text.match(re)?.length ?? 0);
  const ss = score(s), rs = score(r), cs = score(c), is = score(i);

  if (is >= cs && is >= rs && is >= ss) return 'I1';
  if (cs >= rs && cs >= ss) return 'C1';
  if (rs >= ss) return 'R1';
  return 'S2';
}

function guessDomain(text: string): FocusResult['domain'] {
  if (/(売上|KPI|顧客|上司|会議|案件|実装|デプロイ|リリース)/.test(text)) return 'work';
  if (/(恋|彼氏|彼女|夫|妻|家族|結婚|デート)/.test(text)) return 'love';
  if (/(体調|睡眠|食事|運動|健康|病院)/.test(text)) return 'health';
  if (/(生活|友人|趣味|日常)/.test(text)) return 'life';
  if (/(意図|存在|意味|ビジョン)/.test(text)) return 'core';
  return 'unknown';
}

function guessProtected(text: string): string {
  if (/(責任|納期|締切|秩序|品質|信用)/.test(text)) return '秩序';
  if (/(関係|信頼|家族|チーム|仲間)/.test(text)) return 'つながり';
  if (/(自由|創造|表現|挑戦)/.test(text)) return '自由/創造';
  if (/(安心|安定|健康)/.test(text)) return '安心';
  return '新規';
}

function guessAction(domain: FocusResult['domain']): string {
  switch (domain) {
    case 'work':  return '新規連絡先1名だけ選んで、最初の挨拶1行を送る';
    case 'love':  return '相手の今日の良かった点を1行だけメモして送る';
    case 'health':return '水を一杯飲み、5分だけ深呼吸する';
    case 'life':  return '机の上を1分だけ整えて、今日の一手を1行書く';
    default:      return 'いまの気持ちを1行だけ書く';
  }
}

/* ========= Public API ========= */

/**
 * 与えられた発話から、位相／深度／Qコード等の軽量メタを推定する。
 * 出力は UI/ログのみに使用し、本文へは直接埋め込まない想定。
 */
export function analyzeFocus(input: string): FocusResult {
  const text = String(input ?? '').replace(JA_WS, ' ').trim();

  const { q, qName, conf } = guessQ(text);
  const phase = guessPhase(text);
  const depth = guessDepth(text);
  const domain = guessDomain(text);
  const protectedFocus = guessProtected(text);

  const anchors: string[] = [];
  // ざっくりしたアンカー抽出（名詞っぽい語を軽く拾う）
  (text.match(/[一-龥ぁ-んァ-ンA-Za-z0-9]{2,}/g) || [])
    .slice(0, 6)
    .forEach(w => anchors.push(w));

  return {
    phase,
    depth,
    q,
    qName: qName || (q === 'Q1' ? '秩序' : q),
    qConf: Math.max(0.1, Math.min(0.95, conf || 0.5)),
    domain,
    protectedFocus,
    anchors,
    action: guessAction(domain),
  };
}

export default analyzeFocus;
