// src/lib/iros/language/rephrase/retryPass.ts
// iros — Retry pass (2nd pass) extracted helper
//
// 目的：rephraseEngine.full.ts の retry(2nd pass) を責務分離する（挙動不変）。
// NOTE:
// - ここは “retryの実行本体” なので副作用（LLM呼び出し / console / adopt）を含む。
// - 型は過度に縛らず、現状の engine から渡される値をそのまま受け取る。

export async function runRetryPass(params: {
  // --- context ---
  debug: any; // { traceId, conversationId, userCode, ... }
  opts: any; // { model?, temperature?, ... }
  slotPlanPolicyResolved: any;

  // --- inputs for retry ---
  systemPrompt: string;
  internalPack: any;
  baseDraftForRepair: string;
  userText: string;

  // --- current state from 1st pass ---
  candidate: string; // first-pass candidate (for fallback)
  scaffoldActive: boolean;
  seedFromSlots: string | null;
  inKeys: string[];
  maxLines: number;
  renderEngine: any;

  // flags & thresholds
  isDirectTask: boolean;
  isMicroOrGreetingNow: boolean;
  MIN_OK_LEN: number;

  // 1st verdict reasons (for relaxTooShortOnQCount)
  firstFatalReasons: string[]; // (v as any)?.reasons の配列想定（string化済み推奨）

  // ✅ NEW: retry でも digest を注入するために受け取る（存在する時だけ）
  historyDigestV1?: any | null;

  // --- dependencies (callbacks) ---
  buildRetryMessages: (args: {
    systemPrompt: string;
    internalPack: any;
    baseDraftForRepair: string;
    userText: string;
  }) => any[];

  callWriterLLM: (args: {
    model: string;
    temperature: number;
    messages: any[];
    traceId: string | null;
    conversationId: string | null;
    userCode: string | null;
    audit: any;

    // ✅ NEW: writerCalls.ts が受け取る
    historyDigestV1?: any | null;
  }) => Promise<string>;

  logRephraseOk: (debug: any, keys: string[], text: string, tag: string) => void;

  validateOutput: (raw: string) => { ok: boolean; reason?: string };

  ensureOnePointInOutput: (args: { slotsForGuard: any; llmOut: string }) => { ok: boolean; out: string };
  scaffoldMustHaveOk: (args: { slotKeys: string[]; slotsForGuard: any; llmOut: string }) => {
    ok: boolean;
    missing: string[];
  };
  restoreScaffoldMustHaveInOutput: (args: { llmOut: string; slotsForGuard: any; missing: string[] }) => string;

  makeCandidate: (raw: string, maxLines: number, renderEngine: any) => string;

  runFlagship: (candidate: string, slotsForGuard: any, scaffoldActive: boolean) => any;

  shouldRejectWarnToSeed: (v: any) => boolean;

  safeHead: (s: any, n: number) => string;

  adoptAsSlots: (text: string, note?: string, extra?: any) => any;

  // required for guard/scaffold/flagship
  extractedKeys: string[]; // extracted.keys（logRephraseOk用）
  slotsForGuard: any;
}): Promise<any> {
  const {
    debug,
    opts,
    slotPlanPolicyResolved,

    systemPrompt,
    internalPack,
    baseDraftForRepair,
    userText,

    candidate,
    scaffoldActive,
    seedFromSlots,
    inKeys,
    maxLines,
    renderEngine,

    isDirectTask,
    isMicroOrGreetingNow,
    MIN_OK_LEN,

    firstFatalReasons,

    // ✅ NEW
    historyDigestV1,

    buildRetryMessages,
    callWriterLLM,
    logRephraseOk,
    validateOutput,

    ensureOnePointInOutput,
    scaffoldMustHaveOk,
    restoreScaffoldMustHaveInOutput,

    makeCandidate,
    runFlagship,
    shouldRejectWarnToSeed,
    safeHead,
    adoptAsSlots,

    extractedKeys,
    slotsForGuard,
  } = params;

  console.log('[IROS/FLAGSHIP][RETRY]', {
    traceId: debug?.traceId,
    conversationId: debug?.conversationId,
    userCode: debug?.userCode,
    reason: firstFatalReasons,
  });

  // ✅ retry (2nd pass)
  const retryMessages = buildRetryMessages({
    systemPrompt,
    internalPack,
    baseDraftForRepair,
    userText,
  });

  const raw2 = await callWriterLLM({
    model: opts?.model ?? 'gpt-4o',
    temperature: opts?.temperature ?? 0.7,
    messages: retryMessages,
    traceId: debug?.traceId ?? null,
    conversationId: debug?.conversationId ?? null,
    userCode: debug?.userCode ?? null,

    // ✅ NEW: retry でも digest を注入
    historyDigestV1: historyDigestV1 ?? null,

    audit: {
      mode: 'rephrase_retry',
      // ✅ 1st pass と同じ決定ロジックを使う
      slotPlanPolicy: slotPlanPolicyResolved,
      qCode: debug?.qCode ?? null,
      depthStage: debug?.depthStage ?? null,
    },
  });

  // ログ（LLMの実出力で）
  logRephraseOk(debug, extractedKeys, raw2, 'RETRY_LLM');

  // retry raw validation（最低限の安全）
  {
    const v2 = validateOutput(raw2);
    if (!v2.ok) {
      if (seedFromSlots) return adoptAsSlots(seedFromSlots, `RETRY_${v2.reason}_TO_SEED`, { scaffoldActive });
      return adoptAsSlots(candidate, `RETRY_${v2.reason}_USE_CANDIDATE`, { scaffoldActive });
    }

    const retryLen0 = String(raw2 ?? '').trim().length;

    // ✅ QCOUNT_TOO_MANY で落ちた retry は「短い」だけでは捨てない
    //    （疑問推定の誤爆対策：短く自然な返答が最適解になり得る）
    const fatalReasons = new Set((firstFatalReasons ?? []).map((x) => String(x)));
    const relaxTooShortOnQCount = fatalReasons.has('QCOUNT_TOO_MANY');

    if (!isDirectTask && !isMicroOrGreetingNow && retryLen0 > 0 && retryLen0 < MIN_OK_LEN) {
      if (!relaxTooShortOnQCount) {
        // ✅ retry後も短いなら「seed強制」ではなく「OK本文」を採用する
        // - seedFromSlots は @NEXT_HINT を拾って renderGateway 側で事故る
        // - ここでは raw2（= retryText）を優先し、空なら baseDraft/candidate に落とす
        const chosenText =
          String(raw2 ?? '').trim() ||
          String(baseDraftForRepair ?? '').trim() ||
          String(candidate ?? '').trim();

        return adoptAsSlots(chosenText, 'OK_TOO_SHORT_ACCEPT', { scaffoldActive });
      }

      console.warn('[IROS/FLAGSHIP][RETRY_TOO_SHORT_BUT_ACCEPTED_DUE_TO_QCOUNT]', {
        traceId: debug?.traceId,
        conversationId: debug?.conversationId,
        userCode: debug?.userCode,
        retryLen: retryLen0,
        min: MIN_OK_LEN,
        reasons: Array.from(fatalReasons),
        head: safeHead(String(raw2 ?? ''), 160),
      });
      // fallthrough: accept raw2 as-is
    }
  }

  // scaffold復元（retryでも同様）
  let raw2Guarded = raw2;
  if (scaffoldActive) {
    const onePointFix2 = ensureOnePointInOutput({ slotsForGuard, llmOut: raw2Guarded });
    if (onePointFix2.ok) raw2Guarded = onePointFix2.out;

    const mh0 = scaffoldMustHaveOk({ slotKeys: inKeys, slotsForGuard, llmOut: raw2Guarded });
    if (!mh0.ok) {
      raw2Guarded = restoreScaffoldMustHaveInOutput({
        llmOut: raw2Guarded,
        slotsForGuard,
        missing: mh0.missing,
      });
    }
  }

  let retryCandidate = makeCandidate(raw2Guarded, maxLines, renderEngine);

  // ✅ T_CONCRETIZE: 1行で終わる“そっけなさ”を禁止（決定的に2行へ補う）
  // ↑ ここも固定テンプレが混入する主因なので廃止。
  // - retryCandidate はそのまま採用（短くてもOK）
  // - 伸ばす必要がある場合は上流（seed/slots）で材料を足す
  // （no-op）

  // ✅ 2nd PASS が短い場合も seed には逃げない（retryCandidate をそのまま採用）
  {
    const retryLenNow = String(retryCandidate ?? '').trim().length;
    if (retryLenNow > 0 && retryLenNow < MIN_OK_LEN) {
      console.warn('[IROS/FLAGSHIP][RETRY_STILL_TOO_SHORT]', {
        traceId: debug?.traceId,
        conversationId: debug?.conversationId,
        userCode: debug?.userCode,
        retryLen: retryLenNow,
        min: MIN_OK_LEN,
        head: safeHead(retryCandidate, 160),
        hasSeed: !!seedFromSlots,
      });

      return adoptAsSlots(String(retryCandidate ?? '').trim(), 'FLAGSHIP_RETRY_STILL_TOO_SHORT_ACCEPT', {
        scaffoldActive,
      });
    }
  }

  if (scaffoldActive && retryCandidate) {
    const mhAfterClamp = scaffoldMustHaveOk({ slotKeys: inKeys, slotsForGuard, llmOut: retryCandidate });
    if (!mhAfterClamp.ok) {
      const restored = restoreScaffoldMustHaveInOutput({
        llmOut: retryCandidate,
        slotsForGuard,
        missing: mhAfterClamp.missing,
      });
      retryCandidate = makeCandidate(restored, maxLines, renderEngine);

      if (!retryCandidate || !retryCandidate.trim()) {
        console.warn('[IROS/FLAGSHIP][RETRY_EMPTY_AFTER_RESTORE_CLAMP]', {
          traceId: debug?.traceId,
          conversationId: debug?.conversationId,
          userCode: debug?.userCode,
        });

        const fallback = baseDraftForRepair && baseDraftForRepair.trim() ? baseDraftForRepair : candidate;
        return adoptAsSlots(fallback, 'FLAGSHIP_RETRY_EMPTY_AFTER_RESTORE_USE_BASE_DRAFT', { scaffoldActive });
      }
    }
  }

  const vRetry = runFlagship(retryCandidate, slotsForGuard, scaffoldActive);

  console.log('[IROS/FLAGSHIP][RETRY_VERDICT]', {
    traceId: debug?.traceId,
    conversationId: debug?.conversationId,
    userCode: debug?.userCode,
    level: vRetry?.level,
    reasons: vRetry?.reasons,
    head: safeHead(retryCandidate, 160),
  });

  {
    const retryText = String(retryCandidate ?? '').trim();
    const retryLen = retryText.length;
    const retryLevel = String(vRetry?.level ?? '').toUpperCase();
    const retryReasons = Array.from(new Set(((vRetry?.reasons ?? []) as any[]).map((x) => String(x))));

    const acceptRetry =
      !!vRetry?.ok &&
      retryLevel === 'OK' &&
      retryLen >= MIN_OK_LEN &&
      !retryReasons.includes('NORMAL_SHORT_GENERIC_NO_QUESTION');

    if (acceptRetry) {
      return adoptAsSlots(retryText, 'FLAGSHIP_RETRY_OK', { scaffoldActive });
    }

    if (vRetry && retryLevel === 'WARN' && seedFromSlots) {
      const mustSeed =
        shouldRejectWarnToSeed(vRetry) || retryLen < MIN_OK_LEN || retryReasons.includes('NORMAL_SHORT_GENERIC_NO_QUESTION');
      if (mustSeed) {
        return adoptAsSlots(seedFromSlots, 'FLAGSHIP_RETRY_WARN_TO_SEED', { scaffoldActive });
      }
    }
  }

  const reasonsArr = ((vRetry?.reasons ?? firstFatalReasons ?? []) as any[]).map((x) => String(x));
  const fatalReasons = new Set(Array.from(new Set(reasonsArr)));

  // ✅ soft-fatal（危険ではなく “文章品質” で落ちた）なら seed 退避をしない
  // ✅ さらに seedFromSlots が directive-only（@TASK/@DRAFT だけ）なら採用すると UI が空になるので必ず避ける
  const softFatalReasons = new Set(['QCOUNT_TOO_MANY', 'HEDGE_PRESENT', 'GENERIC_PRESENT']);
  const isSoftFatalOnly =
    fatalReasons.size > 0 && Array.from(fatalReasons).every((r) => softFatalReasons.has(String(r)));

  // ✅ このブロック内だけで使う：directive-only 判定（外部依存なし）
  const isDirectiveOnly = (s0: any): boolean => {
    const lines = String(s0 ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((x) => String(x ?? '').trim())
      .filter(Boolean);

    if (lines.length === 0) return true;
    return lines.every((t) => /^@(?:CONSTRAINTS|OBS|TASK|SHIFT|NEXT(?:_HINT)?|SAFE|ACK|RESTORE|Q|DRAFT)\b/.test(t));
  };

  const seedDirectiveOnly = seedFromSlots ? isDirectiveOnly(seedFromSlots) : false;

  // 既存の prefer 条件に、soft-fatal と directive-only seed 回避を追加
  const shouldPreferCandidateOnFatal =
    seedDirectiveOnly ||
    isSoftFatalOnly ||
    fatalReasons.has('OK_TOO_SHORT_TO_RETRY') ||
    fatalReasons.has('WARN_TO_RETRY');

  if (shouldPreferCandidateOnFatal) {
    const fallback =
      String(retryCandidate ?? '').trim() ||
      String(candidate ?? '').trim() ||
      // seed が directive-only の場合は絶対に使わない（空になる）
      (!seedDirectiveOnly ? String(seedFromSlots ?? '').trim() : '');

    return adoptAsSlots(fallback, 'FLAGSHIP_RETRY_FATAL_PREFER_CANDIDATE', {
      scaffoldActive,
      flagshipFatal: true,
      flagshipLevel: vRetry?.level ?? 'FATAL',
      flagshipReasons: Array.isArray(vRetry?.reasons) ? vRetry.reasons : [],
    });
  }

  // ✅ seedFromSlots を採用するのは「directive-only ではない」場合だけ
  if (seedFromSlots && !seedDirectiveOnly) {
    return adoptAsSlots(seedFromSlots, 'FLAGSHIP_RETRY_FATAL_TO_SEED', { scaffoldActive });
  }

  // seed が使えない（directive-only 等）ときは通常のフォールバックへ
  const fallbackText = String(retryCandidate ?? '').trim() || String(candidate ?? '').trim();
  return adoptAsSlots(fallbackText, 'FLAGSHIP_RETRY_FATAL_ACCEPT', {
    scaffoldActive,
    flagshipFatal: true,
    flagshipLevel: vRetry?.level ?? 'FATAL',
    flagshipReasons: Array.isArray(vRetry?.reasons) ? vRetry.reasons : [],
  });
}

