// src/lib/iros/quality/flagshipGuard.ts
// 旗印ガード：
// 「答えを渡さない / 判断を急がせない / 読み手が自分で答えを出せる場所をつくる」
// を破る出力を検出して REWRITE（書き直し）へ回すための最小判定。

export type FlagshipVerdict = {
  ok: boolean;
  level: 'OK' | 'WARN' | 'FATAL';
  reasons: string[];
  score: {
    fatal: number;
    warn: number;
    qCount: number;
    bulletLike: number;
  };
};

function countMatches(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const re of patterns) {
    const m = text.match(re);
    if (m) n += m.length;
  }
  return n;
}

function countQuestionMarks(text: string): number {
  // 全角/半角を拾う
  const m = text.match(/[？?]/g);
  return m ? m.length : 0;
}

function countBulletLikeLines(text: string): number {
  // 箇条書き・番号付き・A/B などを “増やす” シグナルとして軽く検出
  const lines = text.split('\n').map(s => s.trim());
  let n = 0;
  for (const line of lines) {
    if (!line) continue;
    if (/^[-・•*]/.test(line)) n++;
    else if (/^\d+[.)]/.test(line)) n++;
    else if (/^[A-DＡ-Ｄ][：:]/.test(line)) n++;
    else if (/^(選択肢|パターン|案|方法)\s*[:：]/.test(line)) n++;
  }
  return n;
}

const P_FATAL_ANSWER_GIVING: RegExp[] = [
  /結論[:：]/g,
  /正解は/g,
  /答えは/g,
  /つまり[:：]/g,
  /あなたは(.*)だ/g, // 強い断定（雑に効くので運用で調整可）
  /必ず/g,
  /絶対/g,
  /～すべき/g,
  /すべき/g,
  /した方がいい/g,
  /しなさい/g,
  /やれ/g,
  /決めろ/g,
];

const P_FATAL_RUSH: RegExp[] = [
  /今すぐ/g,
  /今日中/g,
  /早く/g,
  /急いで/g,
  /迷うな/g,
  /まず決めて/g,
  /先に決めて/g,
];

const P_WARN_INTERROGATION: RegExp[] = [
  /(いつ|どこ|誰|何|なに|どうして|なぜ)[:：]?/g,
];

const P_WARN_MORE_OPTIONS: RegExp[] = [
  /選択肢/g,
  /A\/B/g,
  /AとB/g,
  /次の(3|４|4)つ/g,
  /以下の通り/g,
];

const P_WARN_PRAISE_LECTURE: RegExp[] = [
  /大丈夫/g,
  /あなたならできる/g,
  /素晴らしい/g,
  /立派/g,
  /正しい/g,
  /間違いない/g,
  /安心して/g,
];

// --- 判定本体 ---
// 方針：
// - FATAL は ok=false として REWRITE へ
// - WARN は ok=true（ただし reasons/score で上位が書き直し判断できる）
// - 「質問は最大1つ」を FATAL で強制（qCount > 1）

export function flagshipGuard(text: string): FlagshipVerdict {
  const t = (text ?? '').trim();

  const qCount = countQuestionMarks(t);
  const bulletLike = countBulletLikeLines(t);

  const fatal_answer = countMatches(t, P_FATAL_ANSWER_GIVING);
  const fatal_rush = countMatches(t, P_FATAL_RUSH);
  const warn_interrog = countMatches(t, P_WARN_INTERROGATION);
  const warn_options = countMatches(t, P_WARN_MORE_OPTIONS);
  const warn_praise = countMatches(t, P_WARN_PRAISE_LECTURE);

  let fatal = 0;
  let warn = 0;
  const reasons: string[] = [];

  // ✅ 質問は最大1つ（2つ以上は REWRITE）
  if (qCount > 1) {
    fatal += 1;
    reasons.push('TOO_MANY_QUESTIONS');
  }

  if (fatal_answer > 0) {
    fatal += fatal_answer;
    reasons.push('ANSWER_GIVING');
  }

  if (fatal_rush > 0) {
    fatal += fatal_rush;
    reasons.push('RUSHING_DECISION');
  }

  // WARN群（必要なら上位で REWRITE へ回せる情報として残す）
  if (warn_interrog > 0) {
    warn += warn_interrog;
    reasons.push('INTERROGATION_TONE');
  }

  if (warn_options > 0) {
    warn += warn_options;
    reasons.push('MORE_OPTIONS_SIGNAL');
  }

  if (warn_praise > 0) {
    warn += warn_praise;
    reasons.push('PRAISE_LECTURE');
  }

  // 箇条書きっぽさ（増やす圧）も warn に加点
  if (bulletLike > 0) {
    warn += bulletLike;
    reasons.push('BULLET_LIKE');
  }

  const level: FlagshipVerdict['level'] = fatal > 0 ? 'FATAL' : warn > 0 ? 'WARN' : 'OK';

  return {
    ok: level !== 'FATAL',
    level,
    reasons: uniq(reasons),
    score: {
      fatal,
      warn,
      qCount,
      bulletLike,
    },
  };
}

function uniq(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (!x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}
