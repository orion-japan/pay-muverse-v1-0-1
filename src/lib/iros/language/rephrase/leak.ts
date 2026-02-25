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
 * - 「まとめて/要約/整理して」など “完成物を作る/整える” は directTask
 * - ただの知識質問（理由/仕組み/とは/何）まで directTask にしない
 * - 「どうやっていこうかな」などの“内的独り言”を howto 扱いしない
 */
export function extractDirectTask(
  userText: string,
  inputKind: string | null,
): boolean {
  const t = String(userText ?? '').trim();
  if (!t) return false;

  // ✅ 継続トークン（会話を「進めるだけ」）は directTask にしない
  // 例: 「続けてください」「OK」「はい」「お願いします」
  // ※ inputKind が request でも、ここは directTask=false を優先
  const looksLikeContinue =
    t.length <= 24 &&
    /^(続けて(ください)?|つづけて(ください)?|続行(して)?(ください)?|もう少し(続けて)?|そのまま(で)?(続けて)?|次(へ)?(進めて)?|ok|ＯＫ|はい|了解|お願いします?|お願い)$/i.test(
      t,
    );

  if (looksLikeContinue) return false;

  // ✅ “完成物を作る/整える” 明示だけを directTask として扱う
  const isDirectTaskByPhrase =
    /(本文だけ|文面|短文|そのまま使える|作って|出して|まとめて|要約|要約して|整理して|箇条書き|要点|ポイント|結論)/.test(
      t,
    );

  // ✅ HowTo誤爆対策
  // 「どうやって」「どうしたら」単体では directTask にしない
  const hasHowPhrase =
    /(どうやって|どうしたら|どうすれば)/.test(t);

  const hasActionVerb =
    /(すれば|したら|やれば|やる|進め|書い|作っ|直し|修正|変更|設定|実装|導入|対応|整理|まとめ|要約|作成|用意)/.test(
      t,
    );

  const isHowtoLike =
    /(やり方|方法|手順|進め方|コツ|tips|おすすめ|選び方|例を|例:|サンプル)/i.test(
      t,
    ) ||
    (hasHowPhrase && hasActionVerb);

  // ✅ 典型的な“知識質問”っぽさ
  const looksLikeInfoQuestion =
    /(とは|仕組み|理由|意味|なぜ|何|どんな|いつ|どこ|誰|ですか|か\?|？)/.test(
      t,
    );

  // ✅ kind で立てるのは howto/request/qa のみ（task は除外）
  const isDirectTaskByKind =
    inputKind === 'howto' ||
    inputKind === 'request' ||
    inputKind === 'qa';

  return Boolean(
    isDirectTaskByPhrase ||
      isHowtoLike ||
      (isDirectTaskByKind && !looksLikeInfoQuestion),
  );
}
