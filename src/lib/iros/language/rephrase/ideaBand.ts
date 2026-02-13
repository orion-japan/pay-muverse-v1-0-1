// src/lib/iros/language/rephrase/ideaBand.ts
// iros — IDEA_BAND helpers (pure / no side effects)

export const IDEA_BAND_MAX_LINES_DEFAULT = 5;

/**
 * IDEA_BAND で候補行として扱うための“芯”の正規化
 * - bullets / 先頭番号 / 余計な空白を軽く落とす
 */
export function normalizeIdeaBandLine(line: string): string {
  return String(line ?? '')
    .trim()
    .replace(/^[-*•・◯]\s*/u, '')
    .trim();
}

/**
 * IDEA_BAND で避けたい “実行指示/手順” っぽい語
 * - 候補生成レーンなので「やって」「進めて」などは避ける
 */
export const IDEA_BAND_FORBIDDEN_RE =
  /(?:次の\s*\d+|タイマー|分だけ|手順|ToDo|TODO|ステップ|まず\s*は|まず、|やってみ|進めて|実装|着手)/u;

export function endsWithVerbLike(s: string): boolean {
  const t = String(s ?? '');
  return /(?:する|してみる|試す|寄せる|置く|切る|選ぶ|見る|決める|保つ|戻す|捨てる|やめる|続ける|止める|揃える|整える|集中する|優先する|固定する|分離する|検証する|確認する|観測する|記録する)$/u.test(
    t,
  );
}

export function endsWithPlanNoun(s: string): boolean {
  const t = String(s ?? '');
  return /(?:案|方向|路線|方針|仮説|候補|選択肢|モード|レーン|パターン|形|軸)$/u.test(t);
}

/**
 * 1行が IDEA_BAND の「候補行」として成立しているか
 */
export function ideaBandLineLooksLikeCandidate(line: string): boolean {
  const core = normalizeIdeaBandLine(line);
  if (!core) return false;

  // 実行指示は IDEA_BAND では避ける
  if (IDEA_BAND_FORBIDDEN_RE.test(core)) return false;

  // 明示フォーマット（互換）
  if (/^(?:候補|選択肢)\s*[:：]/u.test(core)) return true;
  if (/という選択肢/u.test(core)) return true;

  // 句点や疑問符がある「文章」は候補ではない
  if (/[。．.!！?？]/u.test(core)) return false;

  // 長すぎ/短すぎは候補として弱い
  if (core.length < 4 || core.length > 34) return false;

  // “提案として読める”最低条件
  if (endsWithVerbLike(core)) return true;
  if (endsWithPlanNoun(core)) return true;

  return false;
}

/**
 * bullets/番号/候補ラベルを剥がして中身だけにする（番号正規化用）
 */
export function stripIdeaBandListHead(s: string): string {
  let t = String(s ?? '').trim();

  // bullets: ・ • ● - * – —
  t = t.replace(/^\s*(?:[・•●\-\*\u2013\u2014])\s+/u, '');

  // "1." "1)" "1："など
  t = t.replace(/^\s*\d+\s*(?:[.)。：:])\s*/u, '');

  // "候補:" "選択肢:" など
  t = t.replace(/^\s*(?:候補|選択肢)\s*[:：]\s*/u, '');

  return t.trim();
}

/**
 * “具体っぽさ”スコア（最後＝最有力に寄せる）
 */
export function scoreIdeaBandSpecificity(line: string): number {
  const s = normalizeIdeaBandLine(line);

  if (s.length < 6) return -2;
  if (s.length > 32) return -1;

  let score = 0;

  // “原因候補”語（刺さりやすい）
  if (/(失敗|怖|不安|先延ばし|後回し|決め(たくない|ない)|避け|守って|止まって|動け)/u.test(s)) score += 3;

  // 抽象単語だけは弱い
  if (/^(?:静けさ|感覚|エネルギー|空気|雰囲気|流れ|状態|意識)$/u.test(s)) score -= 3;

  // 対象語/設計語があると強い
  if (/(仕様|契約|レーン|ログ|条件|原因|入口|境界|判定|整合|ズレ|復元|矯正)/u.test(s)) score += 2;

  if (endsWithVerbLike(s)) score += 1;
  if (endsWithPlanNoun(s)) score += 1;

  return score;
}

/**
 * 最も“具体（spotlight）”な行を最後に回す
 */
export function moveBestIdeaBandLineToLast(lines: string[]): string[] {
  if (lines.length < 2) return lines;

  let bestIdx = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < lines.length; i++) {
    const sc = scoreIdeaBandSpecificity(lines[i]);
    if (sc > bestScore) {
      bestScore = sc;
      bestIdx = i;
    }
  }

  const out = lines.slice();
  const [best] = out.splice(bestIdx, 1);
  out.push(best);
  return out;
}

/**
 * "1) ..." 固定の番号形式へ整形（2〜maxLines）
 */
export function asNumberedParenList(lines: string[], maxLines = IDEA_BAND_MAX_LINES_DEFAULT): string {
  const clean = lines
    .map((x) => stripIdeaBandListHead(x))
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, maxLines);

  if (clean.length < 2) return '';

  const spotlighted = moveBestIdeaBandLineToLast(clean);

  return spotlighted
    .map((t, i) => `${i + 1}) ${t}`)
    .join('\n')
    .trim();
}

/**
 * 既に契約OKな IDEA_BAND を「番号 + spotlight」へ正規化する
 */
export function normalizeIdeaBandCandidateText(candidateText: string, maxLines = IDEA_BAND_MAX_LINES_DEFAULT): string {
  const rawLines = String(candidateText ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((x) => stripIdeaBandListHead(x))
    .filter(Boolean)
    .slice(0, maxLines);

  if (rawLines.length < 2) return '';

  return asNumberedParenList(rawLines, maxLines);
}

/**
 * IDEA_BAND 契約評価（候補2〜maxLines行 / 各行が候補形）
 */
export function evaluateIdeaBandContract(candidateText: string, maxLines = IDEA_BAND_MAX_LINES_DEFAULT): {
  ok: boolean;
  lines: string[];
  reasons: string[];
} {
  const ideaBandLines = String(candidateText ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const tooFewLines = ideaBandLines.length < 2;
  const tooManyLines = ideaBandLines.length > maxLines;
  const hasQuestion = ideaBandLines.some((line) => /[?？]/u.test(line));
  const hasForbidden = ideaBandLines.some((line) => IDEA_BAND_FORBIDDEN_RE.test(normalizeIdeaBandLine(line)));

  const candidateShapeOk =
    ideaBandLines.length >= 2 &&
    ideaBandLines.length <= maxLines &&
    ideaBandLines.every(ideaBandLineLooksLikeCandidate);

  const ok = candidateShapeOk && !tooFewLines && !tooManyLines && !hasQuestion && !hasForbidden;

  const reasons: string[] = [];
  if (tooFewLines) reasons.push('IDEA_BAND_TOO_FEW_LINES');
  if (tooManyLines) reasons.push('IDEA_BAND_TOO_MANY_LINES');
  if (hasQuestion) reasons.push('IDEA_BAND_HAS_QUESTION');
  if (hasForbidden) reasons.push('IDEA_BAND_HAS_FORBIDDEN');
  if (!candidateShapeOk) reasons.push('IDEA_BAND_SHAPE_REJECT');

  return { ok, lines: ideaBandLines, reasons };
}

/**
 * “契約違反の文章”を IDEA_BAND 候補行へ寄せる（SALVAGE用）
 * - 文章→短い候補行へ変換するための1行化関数
 */
export function toIdeaBandCandidateLine(raw: string): string {
  const dropTail = (s: string) =>
    s.replace(/(?:かもしれません|かも|ようです|みたいです|でしょう|ですね|です|ます|でした|ました)$/u, '').trim();

  // ① 正規化
  let s = normalizeIdeaBandLine(raw).replace(/[。．.!！?？]+$/u, '').trim();

  // 先頭の箇条書き記号を剥がす
  s = s.replace(/^\s*(?:[-*•●・]+)\s*/u, '');

  // "1. ・ ..." の「番号の後ろの・」も消す
  s = s.replace(/^(\s*\d+\s*[.)]\s*)[-*•●・]+\s*/u, '$1');

  s = dropTail(s);
  if (!s) return '';
  if (IDEA_BAND_FORBIDDEN_RE.test(s)) return '';

  // ② “状況語”を落として核へ
  s = s
    .replace(/^(?:いま|今|その|この)?(?:段階|第一段階|次|直後|越えた今|越えた今、)?[、,]\s*/u, '')
    .replace(/^(?:第一段階を越えた今|第一段階をクリアした後|第一段階をクリアした今)\s*/u, '')
    .replace(/^(?:その)?静けさ(?:の中)?(?:に|で)?/u, '静けさ')
    .trim();

  // ③ 文っぽい時は「後半」を優先
  const parts = s
    .split(/[、,]/u)
    .map((x) => dropTail(x.trim()))
    .filter(Boolean);

  const scorePart = (p: string) => {
    let score = 0;
    if (/(?:探|整|言葉|見つ|掘|ほど|切り分け|分け|置き換え|決め|選ぶ|書く|出す|並べ)/u.test(p)) score += 3;
    if (/(?:鍵|道|道筋|潜む|隠れる|かもしれない)/u.test(p)) score -= 2;
    if (p.length <= 28) score += 1;
    return score;
  };

  if (parts.length >= 2) {
    parts.sort((a, b) => scorePart(b) - scorePart(a));
    s = parts[0];
  } else {
    s = parts[0] ?? s;
  }

  s = dropTail(s).replace(/[。．.!！?？]+$/u, '').trim();
  if (!s) return '';
  if (s.length > 28) s = s.slice(0, 28).trim();

  // ④ 既に候補形式なら温存
  if (/^(?:候補|選択肢)\s*[:：]/u.test(s)) return s;

  // ⑤ 語尾を候補に合わせる
  if (endsWithVerbLike(s) || endsWithPlanNoun(s)) return s;

  if (/心の奥深く/u.test(s)) return '心の奥の“引っかかり”を言葉にする';
  if (/静けさ/u.test(s)) return '静けさの正体を一言で切り分ける';
  if (/鍵/u.test(s)) return '整理の“入口”を1つだけ決める';

  return `${s}を試す`;
}

/**
 * 契約違反のテキストを salvage して「1) ...」候補列に戻す
 */
export function salvageIdeaBand(candidateText: string, maxLines = IDEA_BAND_MAX_LINES_DEFAULT): string {
  const s = String(candidateText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!s) return '';

  // 1) まず行ベース
  let parts = s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

  // 2) 行が少なければ句点/改行相当で分割
  if (parts.length < 2) {
    parts = s
      .split(/[。．.!！\n]+/u)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  // 3) それでも少なければ読点で割る
  if (parts.length < 2) {
    parts = s
      .split(/[、,]+/u)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  const fixed = parts
    .map(toIdeaBandCandidateLine)
    .filter(Boolean)
    .filter((x, i, arr) => arr.indexOf(x) === i)
    .slice(0, maxLines);

  if (fixed.length < 2) return '';

  return asNumberedParenList(fixed, maxLines);
}
// ---- ideaBand.ts (append) ------------------------------------
// iros — IDEA_BAND helpers (pure / no side effects)
// NOTE:
// - rephraseEngine.full.ts 内にあった detectIdeaBandPropose / makeIdeaBandCandidates を
//   ここへ “純粋関数” として外出しするための受け皿。
// - 仕様：2〜5 行（maxLines=IDEA_BAND_MAX_LINES_DEFAULT=5）

export function detectIdeaBandProposeFromExtracted(extracted: any): boolean {
  const safeParseJson = (s0: any): any | null => {
    try {
      return JSON.parse(String(s0 ?? '').trim());
    } catch {
      return null;
    }
  };

  const slots = extracted?.slots;
  if (!Array.isArray(slots)) return false;

  const shift = slots.find((x: any) => String(x?.key ?? '').toUpperCase().includes('SHIFT'));
  const shiftText = String(shift?.text ?? shift?.value ?? '').trim();
  if (!shiftText.startsWith('@SHIFT')) return false;

  const jsonPart = shiftText.replace(/^@SHIFT\b/, '').trim();
  const obj = safeParseJson(jsonPart);
  const kind = String(obj?.kind ?? '').toLowerCase();
  const intent = String(obj?.intent ?? '').toLowerCase();

  return kind === 'idea_band' && intent === 'propose_candidates';
}

/**
 * IDEA_BAND 用：blocks 生成（配列で返す）
 * - 2〜maxLines を狙う（現仕様は maxLines=5）
 * - 番号整形は別責務（UI/別処理）なので、ここでは付けない
 */
export function makeIdeaBandCandidateBlocks(s0: string, maxLines = IDEA_BAND_MAX_LINES_DEFAULT): string[] {
  const s = String(s0 ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!s) return [];

  const MAX = maxLines;

  // 1) 空行区切りで段落化
  let parts = s
    .split(/\n\s*\n+/)
    .map((x) => x.trim())
    .filter(Boolean);

  // 2) 少なすぎる場合、句点で“ゆるく”分割して 2〜MAX を狙う
  if (parts.length < 2) {
    const sentences = s
      .split(/。+/)
      .map((x) => x.trim())
      .filter(Boolean);

    if (sentences.length >= 2) {
      parts = sentences.slice(0, MAX).map((x) => (x.endsWith('。') ? x : `${x}。`));
    }
  }

  // 3) 最終クランプ：2〜MAX（足りない時は []）
  if (parts.length < 2) return [];

  const trimmed = parts
    .map((x) => stripIdeaBandListHead(x))
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, MAX);

  if (trimmed.length < 2) return [];

  return moveBestIdeaBandLineToLast(trimmed);
}
// --------------------------------------------------------------
