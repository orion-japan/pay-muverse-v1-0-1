// --- Q影響: systemプロンプト生成＋監査記録 ---
type BuildOpts = { factual?: boolean };

export async function buildSystemPrompt(base: string, userCode: string, opts: BuildOpts = {}) {
  // 1) 最新+ヒントを取得
  const unifiedRes = await fetch(
    `${process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'}/api/q/unified?user_code=${encodeURIComponent(userCode)}`,
    { headers: { Authorization: `Bearer ${process.env.LOCAL_ID_TOKEN ?? ''}` } } // ローカル実行時のみ。不要なら外す
  ).then(r => r.json()).catch(() => ({ ok:false }));

  // デフォルト
  let used_source: 'current'|'hint'|'none' = 'none';
  let q_value = null as null | string;
  let influence_w = 0;

  if (unifiedRes?.ok && unifiedRes.data) {
    const d = unifiedRes.data as {
      current_q?: string; depth_stage?: string; updated_at?: string;
      q_hint?: string; confidence?: number; last_at?: string;
    };

    // 2) ルール：事実系なら影響0
    if (opts.factual) {
      used_source = 'none';
      q_value = null;
      influence_w = 0;
    } else {
      // 3) “今のQ”を最優先、14日を超えたらヒントへ、ヒントは0.6以上のみ採用
      const now = Date.now();
      const updatedAt = d.updated_at ? new Date(d.updated_at).getTime() : 0;
      const isCurrentFresh = updatedAt && (now - updatedAt) <= 14*24*60*60*1000;

      if (d.current_q && isCurrentFresh) {
        used_source = 'current';
        q_value = d.current_q;
        influence_w = 0.20; // w_Q=0.15–0.25 の推奨帯で固定
      } else if (d.q_hint && (d.confidence ?? 0) >= 0.6) {
        used_source = 'hint';
        q_value = d.q_hint;
        influence_w = 0.18; // ヒントはやや弱め
      } else {
        used_source = 'none';
        q_value = null;
        influence_w = 0;
      }
    }
  }

  // 4) 監査保存（制約に合わせて 'current' | 'hint' | 'none' のみ）
  //   ※ ローカルIDトークンが無い環境では try/catch で握りつぶす
  try {
    if (used_source !== 'none') {
      await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'}/api/q/audit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.LOCAL_ID_TOKEN ? { Authorization: `Bearer ${process.env.LOCAL_ID_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          used_source, q_value, influence_w, why_not_q: null,
        }),
      });
    }
  } catch { /* no-op */ }

  // 5) system を組み立て
  // 影響はトーン/問い順のみ、事実系は影響0
  const qLine = (used_source !== 'none' && q_value)
    ? `Q-influence: use a subtle tone for ${q_value} (weight=${influence_w}).`
    : `Q-influence: none (factual or low confidence).`;

  const guard = `Never alter facts, dates, prices, regulations, or translations based on Q-influence.`;

  return `${base}\n${qLine}\n${guard}`;
}
