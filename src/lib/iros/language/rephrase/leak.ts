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

// src/lib/iros/language/rephrase/leak.ts

/**
 * ✅ 直接タスク判定
 * - 「まとめて/要約/整理して」など “完成物を作る/整える” は directTask
 * - ただの知識質問（理由/仕組み/とは/何）まで directTask にしない
 */
export function extractDirectTask(userText: string, inputKind: string | null): boolean {
  const t = String(userText ?? '').trim();

  // ✅ “完成物を作る/整える” 明示だけを directTask として扱う
  // （技術会話=task は directTask にしない）
  const isDirectTaskByPhrase =
    /(本文だけ|文面|短文|そのまま使える|作って|出して|まとめて|要約|要約して|整理して|箇条書き|要点|ポイント|結論)/.test(t);

  // ✅ HowTo/指南ワード（※「教えてください」は広すぎるので入れない）
  const isHowtoLike =
    /(やり方|方法|手順|どうやって|どうしたら|進め方|コツ|tips|おすすめ|選び方|例を|例:|サンプル)/i.test(t);

  // ✅ 典型的な“知識質問”っぽさ（ここに引っかかるものは directTask にしない）
  const looksLikeInfoQuestion =
    /(とは|仕組み|理由|意味|なぜ|何|どんな|いつ|どこ|誰|ですか|か\?|？)/.test(t);

  // ✅ kind で立てるのは howto/request/qa のみ（task は除外）
  // ただし「知識質問っぽい」ものは directTask に倒さない
  const isDirectTaskByKind = inputKind === 'howto' || inputKind === 'request' || inputKind === 'qa';

  return Boolean(isDirectTaskByPhrase || isHowtoLike || (isDirectTaskByKind && !looksLikeInfoQuestion));
}
