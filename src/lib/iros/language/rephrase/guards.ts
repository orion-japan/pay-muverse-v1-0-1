// src/lib/iros/language/rephrase/guards.ts
// iros — Rephrase Guards (pure checks)
// - Recall-check hard guard (Phase11)
// - Writer guard (minimal)
//
// NOTE:
// - rephraseEngine.ts から “判定ロジック” を分離するだけ（挙動は変えない）
// - 副作用なし（console.log は呼び出し側で行う）

// -------------------------------
// Recall-check hard guard (Phase11)
// -------------------------------
function normLite(s: any): string {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function extractJsonTail(line: string): any | null {
  const t = normLite(line);
  const m = t.match(/^\s*@\w+\s+(\{[\s\S]*\})\s*$/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export function shouldEnforceRecallGuard(slotKeys: string[]): boolean {
  const set = new Set(slotKeys.map((k) => String(k).toUpperCase()));
  // recall-check は RESTORE + Q が揃ってるときにだけ強制（他の通常会話には影響させない）
  return set.has('RESTORE') && set.has('Q');
}

export function getRecallMustHaveFromSlots(
  slots: Array<{ key: string; text?: string; content?: string; value?: string }> | null,
): { restoreNeedle: string | null; questionNeedle: string | null } {
  if (!Array.isArray(slots) || slots.length === 0) return { restoreNeedle: null, questionNeedle: null };

  const byKey = (k: string) =>
    slots.find((s) => String((s as any)?.key ?? '').toUpperCase() === k.toUpperCase()) ?? null;

  const restore = byKey('RESTORE');
  const q = byKey('Q');

  const restoreText = normLite(
    (restore as any)?.text ?? (restore as any)?.content ?? (restore as any)?.value ?? '',
  );
  const qText = normLite((q as any)?.text ?? (q as any)?.content ?? (q as any)?.value ?? '');

  // RESTORE: JSONが取れれば last / summary 系を優先
  const rj = extractJsonTail(restoreText);
  const restoreNeedleRaw =
    normLite(rj?.last ?? rj?.summary ?? rj?.head ?? rj?.topic ?? '') ||
    normLite(restoreText.replace(/^@RESTORE\s*/i, ''));

  // Q: JSONが取れれば ask を優先
  const qj = extractJsonTail(qText);
  const questionNeedleRaw =
    normLite(qj?.ask ?? qj?.q ?? qj?.question ?? '') || normLite(qText.replace(/^@Q\s*/i, ''));

  // needle が短すぎると誤判定するので最低長を持たせる
  // ✅ ただし “取れない” 場合に備えて、先頭40字フォールバックを入れておく
  const restoreNeedle =
    restoreNeedleRaw && restoreNeedleRaw.length >= 4
      ? restoreNeedleRaw
      : restoreText
        ? restoreText.slice(0, 40)
        : null;

  const questionNeedle =
    questionNeedleRaw && questionNeedleRaw.length >= 4
      ? questionNeedleRaw
      : qText
        ? qText.slice(0, 40)
        : null;

  // それでも短いならガードを弱める（事故で全部捨てるのを防ぐ）
  const rn = restoreNeedle && restoreNeedle.length >= 4 ? restoreNeedle : null;
  const qn = questionNeedle && questionNeedle.length >= 4 ? questionNeedle : null;

  return { restoreNeedle: rn, questionNeedle: qn };
}

export function recallGuardOk(args: {
  slotKeys: string[];
  slotsForGuard: Array<{ key: string; text?: string; content?: string; value?: string }> | null;
  llmOut: string;
}): { ok: boolean; missing: string[]; needles: { restore: string | null; q: string | null } } {
  const out = normLite(args.llmOut);
  if (!out) return { ok: false, missing: ['OUT_EMPTY'], needles: { restore: null, q: null } };

  if (!shouldEnforceRecallGuard(args.slotKeys)) {
    return { ok: true, missing: [], needles: { restore: null, q: null } };
  }

  const { restoreNeedle, questionNeedle } = getRecallMustHaveFromSlots(args.slotsForGuard);

  // ✅ 「質問が入っているか」の緩い判定（現状維持）
  // - FLAG_TRUE_QUESTION_* による “問い” は、? が無い場合もあるので
  //   ここでは疑問語も含めて拾う（needle の完全一致は下で別途見る）
  const hasQuestion = (() => {
    if (/[？?]/.test(out)) return true;
    if (/(どの|どれ|どっち|どこ|いつ|だれ|誰|なぜ|なんで|どうして|どう|何|どんな)/.test(out)) {
      return true;
    }
    return false;
  })();

  // ✅ RESTORE の“起きてる”判定を、完全一致→部分一致/短縮一致/トークン一致に緩める
  const hasRestore = (() => {
    if (!restoreNeedle) return true; // needle が取れないならガードしない

    const needle = normLite(restoreNeedle);
    if (!needle) return true;

    // 1) そのまま含まれていればOK
    if (out.includes(needle)) return true;

    // 2) 長い needle は先頭だけでも一致すればOK（言い換え事故を吸収）
    const short = needle.length >= 10 ? needle.slice(0, 10) : needle;
    if (short.length >= 6 && out.includes(short)) return true;

    // 3) 「」の中身があれば、それで一致判定
    const m = needle.match(/「([^」]{4,})」/);
    if (m?.[1]) {
      const inner = normLite(m[1]);
      if (inner.length >= 4 && out.includes(inner)) return true;
    }

    // 4) トークン一致（日本語でも壊れにくい最小実装）
    //    - 2文字以上の断片を拾って、2個以上が本文に含まれれば「復元できてる」とみなす
    const tokens = needle
      .replace(/[。、・,.\(\)\[\]\{\}「」『』"'\s]+/g, ' ')
      .split(' ')
      .map((x) => x.trim())
      .filter((x) => x.length >= 2)
      .slice(0, 8);

    if (tokens.length === 0) return true;

    let hit = 0;
    for (const t of tokens) {
      if (out.includes(t)) hit++;
      if (hit >= 2) return true;
    }

    return false;
  })();

  const missing: string[] = [];

  // RESTORE: “復元が起きてるか” を見る（完全一致は要求しない）
  if (!hasRestore) missing.push('RESTORE');

  // Q:
  // - needle があるなら「含まれていれば最高」(完全一致)。
  // - ただし、言い換えで needle が崩れることがあるので、
  //   “質問の存在” があれば OK に倒す（全部破棄事故を防ぐ）
  if (questionNeedle) {
    const qNeedle = normLite(questionNeedle);
    const hasExactNeedle = qNeedle ? out.includes(qNeedle) : false;
    if (!hasExactNeedle && !hasQuestion) missing.push('Q');
  } else {
    if (!hasQuestion) missing.push('Q');
  }

  return {
    ok: missing.length === 0,
    missing,
    needles: { restore: restoreNeedle, q: questionNeedle },
  };
}

// -------------------------------
// ✅ writer guard (minimal)
// -------------------------------
export type WriterGuardRules = {
  output_only?: boolean;
  questions_max?: number;
  no_bullets?: boolean; // DRAFT.rules.no_bullets を尊重
};

// src/lib/iros/language/rephrase/guards.ts

export function checkWriterGuardsMinimal(args: {
  text: string;
  rules?: WriterGuardRules | null;
}): { ok: true } | { ok: false; reason: string; detail?: any } {
  const text = String(args.text ?? '');
  const rules = args.rules ?? null;

  if (!text.trim()) return { ok: false, reason: 'WG:OUT_EMPTY' };

  const outputOnly = !!rules?.output_only;
  const noBullets = rules?.no_bullets !== false; // デフォ true 扱い
  const qMax = typeof rules?.questions_max === 'number' ? rules?.questions_max : null;

  // -----------------------------------------
  // 1) questions_max
  // - 旧: ?/？ のみ
  // - 新: 日本語の疑問（ですか/どちら/何/なぜ/どう 等）も数える
  // -----------------------------------------
  const countQuestionsLike = (s: string): number => {
    const t = String(s ?? '');

    // (A) 明示の疑問符
    let count = (t.match(/[?？]/g) ?? []).length;

    // (B) 行末の疑問終止（疑問符なしでも “質問” とみなす）
    // 例: 「〜ですか」「〜ますか」「〜でしょうか」「〜かな」「〜だろうか」
    // NOTE: “〜です” などは含めない（誤検知を減らす）
    const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
    const endQuestionRe =
      /(ですか|ますか|でしょうか|でしたか|ましたか|ませんか|だろうか|かな|かもね|かね)([。．…]*\s*)$/;

    for (const line of lines) {
      if (endQuestionRe.test(line)) count += 1;
    }

    // (C) 疑問詞（何/どれ/どちら/いつ/どこ/だれ/なぜ/どう/いくつ）
    // - これも「質問っぽさ」の主因なので加点する
    // - ただし過剰検知を避けるため、1行につき最大1加点
    const whRe =
      /(何|なに|どれ|どちら|いつ|どこ|だれ|誰|なぜ|何故|どう|どの|いくつ|幾つ|どんな|どこで|どこに|どこから|どこまで)\b/;

    for (const line of lines) {
      // 疑問符や疑問終止で既に質問扱いなら二重加点しない
      if (/[?？]/.test(line) || endQuestionRe.test(line)) continue;
      if (whRe.test(line)) count += 1;
    }

    return count;
  };

  if (qMax != null) {
    const qCount = countQuestionsLike(text);
    if (qCount > qMax) return { ok: false, reason: 'WG:Q_OVER', detail: { qCount, qMax } };
  }

  // -----------------------------------------
  // 2) output_only
  // -----------------------------------------
  if (outputOnly) {
    // bullets
    if (noBullets) {
      const hasBullets =
        /(^|\n)\s*[-*•●▪︎◦]\s+/.test(text) || /(^|\n)\s*\d+\.\s+/.test(text);
      if (hasBullets) return { ok: false, reason: 'WG:BULLETS' };
    }

    // “解説します/ポイント/以下/まとめ/結論から” などのメタ文章（強すぎない範囲で最小）
    const hasMeta =
      /解説|ポイント|まとめ|結論から|要約|箇条書き|チェックリスト|手順|まずは|次に|以下/.test(text);

    // output_only でも「短い導入1行」までは許容したいが、
    // 2行以上のメタ構造になっている場合だけ落とす（最小）
    if (hasMeta) {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const metaLines = lines.filter((l) => /解説|ポイント|まとめ|結論から|要約|以下/.test(l));
      if (metaLines.length >= 1 && lines.length >= 5) {
        return { ok: false, reason: 'WG:OUTPUT_ONLY_META', detail: { metaLines: metaLines.slice(0, 2) } };
      }
    }
  }

  return { ok: true };
}
