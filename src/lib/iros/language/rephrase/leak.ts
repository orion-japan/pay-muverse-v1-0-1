// src/lib/iros/language/rephrase/leak.ts
// iros — rephrase leak safety helpers

/**
 * 露出禁止：制御マーカー / internal pack ラベル
 * - output に混入していたら即 reject
 */
export function containsForbiddenLeakText(
  output: string,
  opts?: { ilineOpen?: string; ilineClose?: string },
): boolean {
  const t = String(output ?? '');
  const ILINE_OPEN = opts?.ilineOpen ?? '[[ILINE]]';
  const ILINE_CLOSE = opts?.ilineClose ?? '[[/ILINE]]';

  // 制御マーカー
  if (t.includes(ILINE_OPEN) || t.includes(ILINE_CLOSE)) return true;

  // internal pack ラベル
  if (/INTERNAL PACK\s*\(DO NOT OUTPUT\)/i.test(t)) return true;
  if (/META\s*\(DO NOT OUTPUT\)/i.test(t)) return true;
  if (/HISTORY_HINT\s*\(DO NOT OUTPUT\)/i.test(t)) return true;
  if (/SEED_DRAFT_HINT\s*\(DO NOT OUTPUT\)/i.test(t)) return true;

  return false;
}

/**
 * ✅ 直接タスク判定
 * - 「まとめて/要約/整理して」も “直接タスク” として扱う（要約吸い込みを防ぐ）
 */
export function extractDirectTask(userText: string, inputKind: string | null): boolean {
  const t = String(userText ?? '');

  // ✅ “完成物を作る/整える” 明示だけを directTask として扱う
  // （技術会話=task は directTask にしない）
  const isDirectTaskByPhrase =
    /(本文だけ|文面|短文|そのまま使える|作って|出して|まとめて|要約|要約して|整理して|箇条書き|要点|ポイント|結論)/.test(t);

  // ✅ HowTo/指南（ただし「具体的/提案」単体では立てない）
  const isHowtoLike =
    /(教えて|教えてください|アドバイス|やり方|方法|手順|どうやって|どうしたら|進め方|コツ|秘技|tips|howto|おすすめ|選び方|例を|例:|サンプル)/i.test(
      t,
    );

  // ✅ kind で立てるのは howto/request/qa のみ（task は除外）
  const isDirectTaskByKind = inputKind === 'howto' || inputKind === 'request' || inputKind === 'qa';

  return Boolean(isDirectTaskByPhrase || isDirectTaskByKind || isHowtoLike);
}
