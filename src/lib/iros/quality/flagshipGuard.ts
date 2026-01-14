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

export function judgeFlagship(text: string): FlagshipVerdict {
  const t = (text ?? '').trim();

  const qCount = countQuestionMarks(t);
  const bulletLike = countBulletLikeLines(t);

  const fatalAnswer = countMatches(t, P_FATAL_ANSWER_GIVING);
  const fatalRush = countMatches(t, P_FATAL_RUSH);

  const warnInterrogation = countMatches(t, P_WARN_INTERROGATION);
  const warnOptions = countMatches(t, P_WARN_MORE_OPTIONS);
  const warnPraise = countMatches(t, P_WARN_PRAISE_LECTURE);

  // ---- スコア設計（最小）----
  // FATAL: 「答えを渡す」or「急がせる」が一定以上
  // WARN : 質問過多 / 選択肢増 / 説教・持ち上げ が一定以上
  let fatal = 0;
  let warn = 0;
  const reasons: string[] = [];

  if (fatalAnswer >= 2) {
    fatal += 2;
    reasons.push('答えを渡す/断定/指示が強い（旗印NG-A）');
  } else if (fatalAnswer >= 1) {
    warn += 1;
    reasons.push('断定/助言が混ざる（NG-A予備軍）');
  }

  if (fatalRush >= 1) {
    fatal += 2;
    reasons.push('判断を急がせている（旗印NG-B）');
  }

  if (qCount >= 2) {
    warn += 2;
    reasons.push('質問が多い（旗印NG-C）');
  } else if (qCount === 1 && warnInterrogation >= 2) {
    warn += 1;
    reasons.push('詰問寄り（NG-C）');
  }

  if (bulletLike >= 3 || warnOptions >= 1) {
    warn += 2;
    reasons.push('選択肢を増やしている（旗印NG-D）');
  }

  if (warnPraise >= 2) {
    warn += 1;
    reasons.push('励まし/評価が主になっている（旗印NG-E）');
  }

  // 最終判定
  let level: FlagshipVerdict['level'] = 'OK';
  let ok = true;

  if (fatal >= 2) {
    level = 'FATAL';
    ok = false;
  } else if (warn >= 2) {
    level = 'WARN';
    ok = false; // WARNでも「書き直し」に回す運用推奨
  }

  return {
    ok,
    level,
    reasons: reasons.length ? reasons : ['旗印に対して大きな違反は検出されませんでした'],
    score: { fatal, warn, qCount, bulletLike },
  };
}
