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
// ✅ 重要：フォールバックは存在させない（空は空のまま返す / “沈黙”を尊重する）

import type { AllowSchema, SpeechAct } from './types';

type EnforceResult = {
  act: SpeechAct;
  text: string; // 最終出力（ラベルなし / 空は空で返す）
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

// 軽い危険語（“助言したい本能” の露出をカット）
const ADVICE_LIKE = /(してみて|すると良い|おすすめ|べき|必要|まずは|焦らず|大丈夫|サポートします)/u;

function normalizeLines(text: string): string[] {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function allowedMap(allow: AllowSchema): Record<string, boolean> {
  if (allow.act === 'SILENCE') return {};
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

// ✅ “助言テンプレ” が混ざるなら中身を落とす（行ごと捨てる）
function dropAdviceLikeContent(content: string): string {
  if (!content) return '';
  if (!ADVICE_LIKE.test(content)) return content;
  return ''; // 危険なら丸ごと捨てる（穴埋めしない）
}

// ✅ 許可されるのは「ラベル付き行」だけ（器の言語）。ただし最終出力はラベル除去。
function extractAllowedLine(line0: string): { kind: keyof typeof LABELS; content: string } | null {
  const kind = detectKind(line0);
  if (!kind) return null;
  const content = stripLabel(line0, kind);
  return { kind, content };
}

export function enforceAllowSchema(allow: AllowSchema, rawText: string): EnforceResult {
  const act = allow.act;
  const maxLines = allow.maxLines ?? 2;

  // ✅ SILENCE は必ず空（“…”禁止）
  // 呼ばれない想定だが、最終ゲートとして「沈黙の秩序」を保証する
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

    const safeContent = dropAdviceLikeContent(x.content);
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

  // ✅ 3) 空になった場合：フォールバックを作らない（空は空）
  // ここが「最後の強制整形（上書き）」の停止点
  if (out.length === 0) {
    return { act, text: '', dropped, kept: 0 };
  }

  return { act, text: out.join('\n'), dropped, kept: out.length };
}
