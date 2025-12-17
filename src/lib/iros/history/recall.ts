// src/lib/iros/history/recall.ts

export type RecallResult =
  | {
      /** gateが直接返答を確定させない（＝場を切らない） */
      assistantText: string | null;

      recallKind: 'recall_from_history';
      /** ここが “材料” になる */
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

/** 「recall返答そのもの」や「固定テンプレ」を拾う事故を防ぐ */
function isRecallAnswerLike(s: string): boolean {
  const t = (s ?? '').trim();
  if (!t) return true;

  // 代表的な recall テンプレ（今後増えたらここに足す）
  if (t.startsWith('たぶんこれのことかな：')) return true;
  if (t.startsWith('たぶんこれのことかな：「')) return true;

  return false;
}

function looksMeaningful(s: string): boolean {
  if (!s) return false;

  // ★ 質問文は recall 候補にしない
  if (isQuestionLike(s)) return false;

  // ★ recallテンプレの自己参照ループを除外
  if (isRecallAnswerLike(s)) return false;

  // ★ 固定アンカーだけ拾う事故を避ける
  if (/^太陽SUN$/.test(s)) return false;

  // ★ 短すぎ除外
  if (s.length < 8) return false;

  // ★ 開発ログ・コマンド除外
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

    /**
     * ✅ ここで喋らない
     * - 「たぶんこれのことかな」テンプレで場を切らない
     * - recalledText を Writer/LLM に渡して自然言語化させる
     */
    assistantText: null,
  };
}
