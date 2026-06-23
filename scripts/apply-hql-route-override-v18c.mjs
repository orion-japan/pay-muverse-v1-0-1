import fs from 'node:fs';

const p = 'src/app/api/agent/iros/reply/route.ts';
let s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

if (!s.includes('HQL_ROUTE_OVERRIDE_V18C')) {
  const constDecl = `    const preSeedDecision = await resolvePreSeedDecision({`;
  const letDecl = `    let preSeedDecision = await resolvePreSeedDecision({`;

  if (s.includes(constDecl)) {
    s = s.replace(constDecl, letDecl);
  } else if (!s.includes(letDecl)) {
    throw new Error('preSeedDecision declaration not found');
  }

  const logNeedle = `console.log('[IROS/ROUTE][PRE_SEED_AFTER_RESOLVE]'`;
  const logIdx = s.indexOf(logNeedle);
  if (logIdx < 0) throw new Error('PRE_SEED_AFTER_RESOLVE log not found');

  const insertAt = s.lastIndexOf('\n', logIdx) + 1;

  const insert = `    // HQL_ROUTE_OVERRIDE_V18C
    // resolver が normal_chat を返しても、ethical_abundance_refusal / hidden_question_landing は通常ルートへ流さない。
    {
      const rawHqlProbe = [
        userTextClean,
        JSON.stringify((preSeedMeta as any)?.resolvedAsk ?? {}),
        JSON.stringify((preSeedMeta as any)?.question ?? {}),
        JSON.stringify((preSeedMeta as any)?.ctxPack ?? {}),
        JSON.stringify((preSeedDecision as any)?.metaPatch ?? {}),
        JSON.stringify((preSeedDecision as any)?.ctxPackPatch ?? {}),
      ].join('\\n');

      const isEthicalAbundanceHql =
        /hidden_question_landing|answer_hidden_question|ethical_abundance_refusal/u.test(rawHqlProbe) ||
        (
          /(AI|きれいごと|綺麗事|自由|好きなことで働く|好きなことで稼ぐ)/u.test(userTextClean) &&
          /(人の不安|不安を.*使|不安を.*見つけ|きれいな言葉|綺麗な言葉|お金|儲け|買わせ|売り物)/u.test(userTextClean) &&
          /(AIも同じ|AI.*同じ|最後はお金|お金に変える|刺激して.*お金|不安.*お金)/u.test(userTextClean)
        );

      if (isEthicalAbundanceHql && String((preSeedDecision as any)?.route || '') !== 'hql_creation_landing') {
        const directReply = [
          '疑っているのは、AIそのものというより、人の不安を見つけて、きれいな言葉に変えて、最後にお金へ流す構造です。',
          '',
          'だから「自由に生きよう」という言葉も、希望ではなく、誰かの弱さを材料にする言葉に聞こえてしまう。',
          '',
          '本当に問われているのは、そこに飲まれずに、誠実なまま自由や豊かさを生めるのか、ということです。'
        ].join('\\n');

        preSeedDecision = {
          ...((preSeedDecision as any) ?? {}),
          kind: 'hql_creation_landing',
          memoryIntent: 'normal_chat',
          memorySpace: 'normal',
          route: 'hql_creation_landing',
          confidence: 0.97,

          resolvedTarget: null,
          resolvedRelation: null,

          sourceAuthority: 'user_text',
          sourceKind: 'ethical_abundance_refusal',
          sourceId: null,
          sourceText: userTextClean,

          seedText: 'HQL_ROUTE_OVERRIDE_V18C (DO NOT OUTPUT): ethical_abundance_refusal hidden_question_landing',
          directReply,

          shouldUsePreSeedWriter: false,
          shouldBypassWriter: true,
          shouldBypassNormalWriter: true,
          shouldBypassRephrase: true,
          shouldSuppressHistoryForWriter: true,
          shouldSuppressSimilarFlow: true,
          shouldSuppressSlotPlan: true,
          shouldSuppressMemoryDelta: true,
          shouldSuppressNormalResonance: true,

          ctxPackPatch: {
            ...((preSeedDecision as any)?.ctxPackPatch ?? {}),
            hiddenQuestionLanding: true,
            ethicalAbundanceRefusal: true,
            answerHiddenQuestion: true,
            presentationKind: 'ethical_abundance_refusal_hidden_question',
            route: 'hql_creation_landing',
            goalKind: 'hidden_question_landing',
            targetKind: 'hidden_question_landing',
            shiftKind: 'hidden_question_landing',
            replyGoal: { kind: 'hidden_question_landing' },
            resolvedAsk: {
              type: 'hidden_question',
              topic: 'ethical_abundance_refusal',
              source: 'hql_route_override_v18c',
            },
            question: {
              questionType: 'hidden_question',
              outputPolicy: { askBackAllowed: false },
            },
            longTermMemoryNoteText: '',
            memoryDeltaSeed: '',
            intuitionSeed: '',
            topicDigest: '',
            conversationLine: '',
          },

          metaPatch: {
            ...((preSeedDecision as any)?.metaPatch ?? {}),
            hiddenQuestionLanding: true,
            ethicalAbundanceRefusal: true,
            answerHiddenQuestion: true,
            presentationKind: 'ethical_abundance_refusal_hidden_question',
            route: 'hql_creation_landing',
            goalKind: 'hidden_question_landing',
            targetKind: 'hidden_question_landing',
            shiftKind: 'hidden_question_landing',
            replyGoal: { kind: 'hidden_question_landing' },
            resolvedAsk: {
              type: 'hidden_question',
              topic: 'ethical_abundance_refusal',
              source: 'hql_route_override_v18c',
            },
            question: {
              questionType: 'hidden_question',
              outputPolicy: { askBackAllowed: false },
            },
            longTermMemoryNoteText: '',
            memoryDeltaSeed: '',
            intuitionSeed: '',
            topicDigest: '',
            conversationLine: '',
          },

          debug: {
            ...((preSeedDecision as any)?.debug ?? {}),
            reason: 'ethical_abundance_refusal_hidden_question_landing',
            matchedPattern: 'HQL_ROUTE_OVERRIDE_V18C',
            routeReason: 'route_override_bypasses_normal_writer_and_rephrase',
          },
        } as any;

        console.log('[IROS/ROUTE][HQL_ROUTE_OVERRIDE_V18C]', {
          traceId,
          conversationId,
          userCode,
          kind: (preSeedDecision as any)?.kind ?? null,
          route: (preSeedDecision as any)?.route ?? null,
          shouldBypassWriter: (preSeedDecision as any)?.shouldBypassWriter ?? null,
          directReplyLen: String((preSeedDecision as any)?.directReply ?? '').length,
        });
      }
    }

`;

  s = s.slice(0, insertAt) + insert + s.slice(insertAt);

  fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
  console.log('[patched] route override v18c');
} else {
  console.log('[skip] route override already present');
}
