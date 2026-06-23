import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const p = (rel) => path.join(root, rel);
const read = (rel) => fs.readFileSync(p(rel), 'utf8').replace(/\r\n/g, '\n');
const write = (rel, s) => { fs.writeFileSync(p(rel), s, 'utf8'); console.log('[patched]', rel); };
const must = (cond, label) => { if (!cond) throw new Error('Pattern not found: ' + label); };

function insertAfter(s, marker, add, label) {
  if (s.includes(add.trim().split('\n')[0].trim())) { console.log('[skip]', label); return s; }
  must(s.includes(marker), label);
  console.log('[insert]', label);
  return s.replace(marker, marker + add);
}

// 1. postprocess: remove v7 fixed final guard and add observation log.
{
  const rel = 'src/lib/iros/server/handleIrosReply.postprocess.ts';
  let s = read(rel);

  s = s.replace(/\nfunction shouldUseHiddenQuestionFinalGuard[\s\S]*?\nfunction buildResonanceSeedText\(/, '\nfunction buildResonanceSeedText(');
  s = s.replace(/\n\s*if \(shouldUseHiddenQuestionFinalGuard\(userText\)\) \{[\s\S]*?\n\s*\}\n\n\s*\/\/ 2\) metaForSave clone/, '\n\n  // 2) metaForSave clone');

  s = insertAfter(s,
`  // ✅ FLOW_SEED_V1 正本
  if (typeof flowSeed === 'string' && flowSeed.trim()) {
    metaForSave.extra.flowSeed = flowSeed.trim();
  }
`,
`
  try {
    const h = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const ctx: any = (metaForSave as any)?.extra?.ctxPack ?? {};
    const preSeed: any = ctx?.preSeedDecision ?? (metaForSave as any)?.extra?.preSeedDecision ?? null;
    const resolvedAsk: any = ctx?.resolvedAsk ?? (metaForSave as any)?.extra?.resolvedAsk ?? null;
    const sp: any[] = (Array.isArray((orchResult as any)?.meta?.slotPlan) ? (orchResult as any).meta.slotPlan : []) as any[];
    const sh: any = sp.find((x: any) => String(x?.key ?? x?.id ?? '').toUpperCase() === 'SHIFT') ?? null;
    console.log('[IROS/HQL][POSTPROCESS]', {
      conversationId, userCode,
      userHead: h(userText),
      assistantHead: h(finalAssistantText),
      resultContentHead: h((orchResult as any)?.content),
      flowSeedHead: h(flowSeed),
      preSeedKind: preSeed?.kind ?? null,
      preSeedRoute: preSeed?.route ?? null,
      preSeedSourceKind: preSeed?.sourceKind ?? null,
      resolvedAskType: resolvedAsk?.askType ?? null,
      resolvedAskTopic: resolvedAsk?.topic ?? null,
      ctxShiftKind: ctx?.shiftKind ?? null,
      ctxShiftIntent: ctx?.shiftIntent ?? null,
      slotPlanLen: sp.length,
      shiftHead: h(sh?.text ?? sh?.content),
    });
  } catch (e) { console.warn('[IROS/HQL][POSTPROCESS_LOG_FAILED]', e); }
`, 'postprocess HQL log');
  write(rel, s);
}

// 2. normalChat: log if hidden question branch is used.
{
  const rel = 'src/lib/iros/slotPlans/normalChat.ts';
  let s = read(rel);
  s = insertAfter(s,
`      const hiddenSeedText =
        hiddenKind === 'ethical_abundance_refusal'
          ? [
              '表面的なAI批判として扱わない。',
              '拒んでいる未来: 人の不安を使って豊かになる未来。',
              '奥の問い: 私は、誠実なまま自由になれますか。',
              'AI側の姿勢表明、「筋が通っています」、「何に使うか」で閉じない。',
              '行動提案・説明羅列・質問返しをしない。',
            ].join('\n')
          : seedText;
`,
`
      console.log('[IROS/HQL][NORMALCHAT_SLOT]', {
        resolvedAskType,
        resolvedAskTopic: resolvedAskTopic || null,
        questionType,
        hiddenKind,
        shiftKind: 'hidden_question_landing',
        userHead: String(userText ?? '').replace(/\s+/g, ' ').slice(0, 120),
        seedHead: String(seedText ?? '').replace(/\s+/g, ' ').slice(0, 120),
        hiddenSeedHead: String(hiddenSeedText ?? '').replace(/\s+/g, ' ').slice(0, 160),
      });
`, 'normalChat HQL log');
  write(rel, s);
}

// 3. route: log Pre-SEED applied and final sync.
{
  const rel = 'src/app/api/agent/iros/reply/route.ts';
  let s = read(rel);
  s = insertAfter(s,
`      console.log('[IROS/ROUTE][PRE_SEED_DECISION_APPLIED]', {
        traceId,
        conversationId,
        userCode,
        kind: preSeedDecision.kind,
        route: preSeedDecision.route,
        shouldBypassWriter: preSeedDecision.shouldBypassWriter,
        shouldBypassRephrase: preSeedDecision.shouldBypassRephrase,
        directReplyLen: String(preSeedDecision.directReply ?? '').length,
        seedLen: String(preSeedDecision.seedText ?? '').length,
        sourceTextLen: String(preSeedDecision.sourceText ?? '').length,
      });
`,
`
      try {
        const ctx: any = (extraSoT as any)?.ctxPack ?? {};
        const ra: any = ctx?.resolvedAsk ?? null;
        console.log('[IROS/HQL][PRESEED_APPLIED]', {
          traceId, conversationId, userCode,
          kind: preSeedDecision.kind,
          route: preSeedDecision.route,
          sourceKind: (preSeedDecision as any).sourceKind ?? null,
          resolvedAskType: ra?.askType ?? null,
          resolvedAskTopic: ra?.topic ?? null,
          shiftKind: ctx?.shiftKind ?? null,
          shiftIntent: ctx?.shiftIntent ?? null,
          goalKind: ctx?.goalKind ?? (extraSoT as any)?.goalKind ?? null,
          targetKind: ctx?.targetKind ?? (extraSoT as any)?.targetKind ?? null,
          seedHead: String(preSeedDecision.seedText ?? '').replace(/\s+/g, ' ').slice(0, 160),
        });
      } catch (e) { console.warn('[IROS/HQL][PRESEED_APPLIED_LOG_FAILED]', e); }
`, 'route preseed HQL log');

  s = insertAfter(s,
`  // ✅ content優先で確定
  const final = pickText(r?.content, assistantText);
  assistantText = final;
`,
`
  try {
    const h = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const pickedFrom = !isEffectivelyEmptyText(String(r?.content ?? '')) ? 'result.content' : 'assistantText';
    const metaAny: any = metaForSave ?? (r as any)?.meta ?? {};
    const ctx: any = metaAny?.extra?.ctxPack ?? {};
    const text = String(final ?? '');
    console.log('[IROS/HQL][ROUTE_FINAL_SYNC]', {
      traceId, conversationId, userCode,
      pickedFrom,
      resultContentHead: h(r?.content),
      assistantTextSyncedHead: h(assistantText),
      finalHead: h(final),
      hasEscape: /(AIも|AIを信用|何に使うか|使い方|私ができるのは|現実に効く話|使えるかどうか)/.test(text),
      ctxShiftKind: ctx?.shiftKind ?? null,
      ctxShiftIntent: ctx?.shiftIntent ?? null,
      resolvedAskType: ctx?.resolvedAsk?.askType ?? null,
      resolvedAskTopic: ctx?.resolvedAsk?.topic ?? null,
    });
  } catch (e) { console.warn('[IROS/HQL][ROUTE_FINAL_SYNC_LOG_FAILED]', e); }
`, 'route final sync HQL log');
  write(rel, s);
}

console.log('\nDone. Run: npm run typecheck');
