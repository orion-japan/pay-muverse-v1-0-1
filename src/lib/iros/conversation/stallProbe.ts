// src/lib/iros/conversation/stallProbe.ts
// iros — stall probe (pure)
// 目的：反復/ズレ/証拠なし を “メタ優先＋入力補助” で1つの判定にまとめる（orchestrator肥大化防止）

export type StallSeverity = 'none' | 'soft' | 'hard';

export type StallSignal = {
  severity: StallSeverity;
  reason: string;
  detail: {
    streakSameUser: number;          // 直近の user 反復回数（current含む）
    repeatSignal: string | null;     // ctxPack.repeatSignal（例：same_phrase）
    flowDelta: string | null;        // meta.flow.delta（例：RETURN）
    anchorReason: string | null;     // meta.anchorEntry.decision.reason（例：NO_EVIDENCE）
    convReason: string | null;       // meta.convEvidence.reason（例：A!:no_advance_hint）
  };
};

function normText(v: any): string {
  const s = typeof v === 'string' ? v : String(v ?? '');
  return s.replace(/\r\n/g, '\n').trim();
}

function pickUserTextFromMsg(m: any): string {
  const v = m?.text ?? m?.content ?? m?.head ?? '';
  return normText(v);
}

function pickRole(m: any): string {
  return String(m?.role ?? '').toLowerCase();
}

export function computeStallSignal(args: {
  userText: string;
  history?: unknown[] | null;
  meta?: any;
}): StallSignal {
  const meta = args.meta ?? {};
  const historyArr = Array.isArray(args.history) ? (args.history as any[]) : [];

  const userNow = normText(args.userText);
  const userNowHead = userNow.slice(0, 60);

  // --- streakSameUser（current含む）: 「直近で同じ userText が何回続いたか」
  // NOTE:
  // - history末尾に current userText が重複混入するケースがある（UI由来）
  // - 末尾に同一userが複数並ぶこともあるので、連続分は全部 “artifact” として除外する
  let streakSameUser = userNow.length > 0 ? 1 : 0;

  if (userNow.length > 0 && historyArr.length > 0) {
    // 1) history末尾の「userNow と同一の user」を連続スキップ（artifact除外）
    let startIdx = historyArr.length - 1;
    while (startIdx >= 0) {
      const m = historyArr[startIdx];
      if (pickRole(m) !== 'user') break;
      const t = pickUserTextFromMsg(m);
      if (!t) break;
      if (t === userNow) startIdx--; // ✅ 連続分を全部落とす
      else break;
    }

    // 2) その1つ前から「同一 userNow が何回続いたか」を数える
    for (let i = startIdx; i >= 0; i--) {
      const m = historyArr[i];
      if (pickRole(m) !== 'user') continue;

      const t = pickUserTextFromMsg(m);
      if (!t) break;

      if (t === userNow) streakSameUser++;
      else break;

      if (streakSameUser >= 6) break;
    }
  }



  // --- repeatSignal（メタ優先）
  const repeatSignalRaw =
    (meta as any)?.repeatSignal ??
    (meta as any)?.extra?.repeatSignal ??
    (meta as any)?.ctxPack?.repeatSignal ??
    (meta as any)?.extra?.ctxPack?.repeatSignal ??
    null;
  const repeatSignal = typeof repeatSignalRaw === 'string' ? repeatSignalRaw.trim() : null;

  // --- flow.delta
  const flowDeltaRaw =
    (meta as any)?.flow?.delta ??
    (meta as any)?.extra?.flow?.delta ??
    null;
  const flowDelta = typeof flowDeltaRaw === 'string' ? flowDeltaRaw.trim() : null;

  // --- anchorEntry decision reason（NO_EVIDENCE）
  const anchorReasonRaw =
    (meta as any)?.anchorEntry?.decision?.reason ??
    (meta as any)?.extra?.anchorEntry?.decision?.reason ??
    (meta as any)?.anchorEntry_decision?.reason ??
    null;
  const anchorReason = typeof anchorReasonRaw === 'string' ? anchorReasonRaw.trim() : null;

  // --- convEvidence reason（no_advance/no_ctx など）
  const convReasonRaw =
    (meta as any)?.convEvidence?.reason ??
    (meta as any)?.extra?.convEvidence?.reason ??
    null;
  const convReason = typeof convReasonRaw === 'string' ? convReasonRaw.trim() : null;

  // ========= 判定（メタ主導＋入力補助） =========
  const samePhraseByMeta = repeatSignal === 'same_phrase';
  const samePhraseByInput = streakSameUser >= 3; // ✅ 2回は誤爆しやすいので除外
  const samePhrase = samePhraseByMeta || samePhraseByInput;

  const isReturn = flowDelta === 'RETURN';
  const noEvidence = anchorReason === 'NO_EVIDENCE';

  const noAdvanceHint = /A!:no_advance_hint/.test(String(convReason ?? ''));
  const noCtxSummary = /U!:no_ctx_summary/.test(String(convReason ?? ''));

  // hard: 反復 + (証拠なし or RETURN or 前進なし)
  const hard =
    samePhrase &&
    (noEvidence || isReturn || noAdvanceHint);

  // soft: 反復気味 + 兆し
  const soft =
    !hard &&
    ((streakSameUser >= 2 && (isReturn || noEvidence)) || (samePhraseByMeta && (noCtxSummary || isReturn)));

  const severity: StallSeverity = hard ? 'hard' : soft ? 'soft' : 'none';

  const reason =
    hard ? 'STALL_HARD' :
    soft ? 'STALL_SOFT' :
    'NONE';

  return {
    severity,
    reason,
    detail: {
      streakSameUser,
      repeatSignal,
      flowDelta,
      anchorReason,
      convReason,
    },
  };
}
