// file: src/lib/iros/speech/enforceAllowSchema.ts
// iros — Enforce AllowSchema (last gate)
//
// ✅ 目的：LLMの出力が “器(AllowSchema)” を破っても、最終出力を整形して封じる
// - 許可されていない行頭ラベルは捨てる
// - maxLines を超えたら切る
// - NAME/FLIP は助言・問い・一手を落とす（fieldsで制御）
// - COMMIT でも actions は最大2行、question は最大1行に制限
//
// ✅ 重要：最終出力からラベルを完全に消す。
// ✅ v2方針：SILENCE 以外は “空返し” をしない（最低1行を保証）

import type { AllowSchema, SpeechAct } from './types';

type EnforceResult = {
  act: SpeechAct;
  text: string; // 最終出力（ラベルなし）
  dropped: number;
  kept: number;
};

// ラベル検出（行頭のみ）
const LABELS = {
  observe: /^観測：\s*/u,
  name: /^核：\s*/u,
  flip: /^反転：\s*/u,
  commit: /^固定：\s*/u,
  actions: /^一手：\s*/u,
  question: /^問い：\s*/u,
};

// “助言したい本能” の露出（※行を捨てない。語尾だけ削る）
const ADVICE_LIKE = /(してみて|すると良い|おすすめ|べき|必要|まずは|焦らず|大丈夫|サポートします)/u;

function normalizeLines(text: string): string[] {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function allowedMap(allow: AllowSchema): Record<keyof typeof LABELS, boolean> {
  if (allow.act === 'SILENCE') {
    return {
      observe: false,
      name: false,
      flip: false,
      commit: false,
      actions: false,
      question: false,
    };
  }
  const f = (allow as any).fields ?? {};
  return {
    observe: !!f.observe,
    name: !!f.name,
    flip: !!f.flip,
    commit: !!f.commit,
    actions: !!f.actions,
    question: !!f.question,
  };
}

function detectKind(line: string): keyof typeof LABELS | null {
  if (LABELS.observe.test(line)) return 'observe';
  if (LABELS.name.test(line)) return 'name';
  if (LABELS.flip.test(line)) return 'flip';
  if (LABELS.commit.test(line)) return 'commit';
  if (LABELS.actions.test(line)) return 'actions';
  if (LABELS.question.test(line)) return 'question';
  return null;
}

// ✅ ラベル除去して中身だけ返す（最終出力はラベルなし）
function stripLabel(line: string, kind: keyof typeof LABELS): string {
  return line.replace(LABELS[kind], '').trim();
}

// ✅ “助言テンプレ” を薄める（行は捨てない / 空にしない）
function softenAdviceLikeContent(content: string): string {
  const s = String(content ?? '').trim();
  if (!s) return '';

  if (!ADVICE_LIKE.test(s)) return s;

  // 語尾の助言テンプレだけ除去（意味を残す）
  const softened = s
    .replace(/(してみて|すると良い|おすすめ|べき|必要|まずは|焦らず|大丈夫|サポートします)/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 全部消えたら元を短縮して返す（空にしない）
  if (!softened) return s.length > 80 ? s.slice(0, 80) : s;

  return softened;
}

// ✅ 許可されるのは「ラベル付き行」だけ（器の言語）。ただし最終出力はラベル除去。
function extractAllowedLine(line0: string): { kind: keyof typeof LABELS; content: string } | null {
  const kind = detectKind(line0);
  if (!kind) return null;
  const content = stripLabel(line0, kind);
  return { kind, content };
}

function firstNonEmptyLine(text: string): string {
  const lines = normalizeLines(text);
  return lines[0] ?? '…';
}

function clampLines(text: string, maxLines: number): string {
  const ls = normalizeLines(text);
  return ls.slice(0, Math.max(1, maxLines)).join('\n');
}

export function enforceAllowSchema(allow: AllowSchema, rawText: string): EnforceResult {
  const act = allow.act;
  const maxLines = allow.maxLines ?? 2;

  // ✅ SILENCE は必ず空（設計どおり）
  if (act === 'SILENCE') {
    return { act, text: '', dropped: 0, kept: 0 };
  }

  const allowF = allowedMap(allow);
  const lines = normalizeLines(rawText);

  let dropped = 0;

  // 1) 許可ラベル以外は捨てる（ラベルは最終出力から消す）
  const filtered: { kind: keyof typeof LABELS; content: string }[] = [];
  for (const line0 of lines) {
    const x = extractAllowedLine(line0);
    if (!x) {
      dropped++;
      continue;
    }
    if (!allowF[x.kind]) {
      dropped++;
      continue;
    }

    const safeContent = softenAdviceLikeContent(x.content);
    if (!safeContent) {
      dropped++;
      continue;
    }

    filtered.push({ kind: x.kind, content: safeContent });
  }

  // 2) act別の上限制御（COMMITの暴走抑制）
  const out: string[] = [];
  let actionsCount = 0;
  let questionCount = 0;

  for (const x of filtered) {
    if (x.kind === 'actions') {
      actionsCount++;
      if (actionsCount > 2) {
        dropped++;
        continue;
      }
    }
    if (x.kind === 'question') {
      questionCount++;
      if (questionCount > 1) {
        dropped++;
        continue;
      }
    }

    out.push(x.content); // ✅ ラベルなし
    if (out.length >= maxLines) break;
  }

  // 3) ✅ 空になった場合：SILENCE以外は最低1行を保証（v2要件）
  if (out.length === 0) {
    const fallback = softenAdviceLikeContent(firstNonEmptyLine(rawText));

    // actごとの最小成立を作る（ラベルは出さない）
    if (act === 'NAME') {
      return { act, text: clampLines(fallback, 1), dropped, kept: 1 };
    }
    if (act === 'FLIP') {
      // “A→B” が含まれるならそれを優先
      const arrow = fallback.match(/(.+?)→(.+?)(\s|$)/u);
      const flip = arrow ? `${arrow[1].trim()}→${arrow[2].trim()}` : fallback;
      return { act, text: clampLines(flip, 1), dropped, kept: 1 };
    }
    if (act === 'COMMIT') {
      // 固定の最小：1行だけでも成立させる
      return { act, text: clampLines(fallback, Math.min(2, maxLines)), dropped, kept: 1 };
    }

    // FORWARD など：最小の一手相当として1行返す
    return { act, text: clampLines(fallback, 1), dropped, kept: 1 };
  }

  return { act, text: out.join('\n'), dropped, kept: out.length };
}
