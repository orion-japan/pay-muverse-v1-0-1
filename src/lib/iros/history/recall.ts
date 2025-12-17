// src/lib/iros/history/recall.ts

export type RecallResult =
  | {
      assistantText: string;
      recallKind: 'recall_from_history';
      recalledText: string;
    }
  | null;

/* ---------------------------
   判定
---------------------------- */

export function isGenericRecallQuestion(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;

  return /さっき|この前|昨日|前(に)?|今(さっき)?|なんだっけ|何だっけ|どれだっけ|どの話|それって|あれって|覚えてる|思い出/.test(
    t,
  );
}

/* ---------------------------
   抽出ユーティリティ
---------------------------- */

function normalize(s: any): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function isQuestionLike(s: string): boolean {
  if (!s) return true;
  if (/[？?]$/.test(s)) return true;
  if (/なんだっけ|何だっけ|覚えて|思い出|どれ/.test(s)) return true;
  return false;
}

function looksMeaningful(s: string): boolean {
  if (!s) return false;
  if (isQuestionLike(s)) return false;
  if (s.length < 8) return false;

  // 開発ログ・コマンド除外
  if (/^(\$|>|\[authz\]|\[IROS\/|GET \/|POST \/)/.test(s)) return false;
  if (/^(rg |sed |npm |npx |curl )/.test(s)) return false;

  return true;
}

/* ---------------------------
   履歴から拾う（conversation ID またぎ対応）
---------------------------- */

export function pickRecallFromHistory(history: any[]): string | null {
  if (!Array.isArray(history) || history.length === 0) return null;

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) continue;
    if (String(m.role).toLowerCase() !== 'user') continue;

    const s = normalize(m.content ?? m.text ?? m.message);
    if (looksMeaningful(s)) return s;
  }
  return null;
}

/* ---------------------------
   メインエントリ
---------------------------- */

export async function runGenericRecallGate(args: {
  text: string;
  history: any[];
}): Promise<RecallResult> {
  const { text, history } = args;

  if (!isGenericRecallQuestion(text)) return null;

  const recalled = pickRecallFromHistory(history);
  if (!recalled) return null;

  return {
    recallKind: 'recall_from_history',
    recalledText: recalled,
    assistantText: `たぶんこれのことかな：「${recalled}」です。🪔`,
  };
}
