export async function generateIrosReply(params: {
  userText: string;
  history?: any[];
  meta?: any;
}): Promise<string> {
  const { userText, history = [], meta = {} } = params;

  try {
    // --- Muの生成関数を動的import ---
    const { generateMuReply } = await import('@/lib/mu/generate');

    // --- ctx（MuContext準拠）---
    const ctx = {
      phase: 'Inner' as const, // ✅ 型をリテラル指定
      agent: 'iros',
      meta,
      user_code: meta.user_code || 'anonymous',
      master_id: meta.master_id || 'default-master',
      sub_id: meta.sub_id || 'default-sub',
    };

    // --- Muモジュール呼び出し（2引数）---
    const reply = await generateMuReply(userText, ctx);

    // --- 結果を整形 ---
    if (typeof reply === 'string') return reply;
    if (reply?.reply) return reply.reply;

    throw new Error('Invalid Mu response format');
  } catch (err) {
    console.error('[Iros/generate] Mu module not found or failed.', err);
    throw new Error('Mu module not found or failed');
  }
}
