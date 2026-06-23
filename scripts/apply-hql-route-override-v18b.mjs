import fs from 'node:fs';

const p = 'src/app/api/agent/iros/reply/route.ts';
let s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

if (!s.includes('HQL_ROUTE_OVERRIDE_V18B')) {
  const constDecl = `    const preSeedDecision = await resolvePreSeedDecision({`;
  if (!s.includes(constDecl)) throw new Error('preSeedDecision const decl not found');
  s = s.replace(constDecl, `    let preSeedDecision = await resolvePreSeedDecision({`);

  const anchor = `    {
      console.log('[IROS/ROUTE][PRE_SEED_AFTER_RESOLVE]', {`;

  const insert = `    // HQL_ROUTE_OVERRIDE_V18B
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

      if (isEthicalAbundanceHql && (preSeedDecision as any)?.route !== 'hql_creation_landing') {
        const directReply = [
          '疑っているのは、AIそのものというより、人の不安を見つけて、きれいな言葉に変えて、最後にお金へ流す構造です。',
          '',
          'だから「自由に生きよう」という言葉も、希望ではなく、誰かの弱さを材料にする言葉に聞こえてしまう。',
          '',
          '本当に問われているのは、そこに飲まれずに、誠実なまま自由や豊かさを生めるのか、ということです。'
        ].join('\\n');

        preSeedDecision = {
          ...(preSeedDecision as any),
          kind: 'hql_creation_landing',
          memoryIntent: 'normal_chat',
          memorySpace: 'normal',
          route: 'hql_creation_landing',
          confidence: 0.97,
          sourceAuthority: 'user_text',
          sourceKind: 'ethical_abundance_refusal',
          sourceId: null,
          sourceText: userTextClean,
          seedText: 'HQL_ROUTE_OVERRIDE_V18B (DO NOT OUTPUT): ethical_abundance_refusal hidden_question_landing',
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
              source: 'hql_route_override_v18b',
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
              source: 'hql_route_override_v18b',
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
            matchedPattern: 'HQL_ROUTE_OVERRIDE_V18B',
            routeReason: 'route_override_bypasses_normal_writer_and_rephrase',
          },
        } as any;

        console.log('[IROS/ROUTE][HQL_ROUTE_OVERRIDE_V18B]', {
          traceId,
          conversationId,
          userCode,
          kind: (preSeedDecision as any)?.kind ?? null,
          route: (preSeedDecision as any)?.route ?? null,
          directReplyLen: String((preSeedDecision as any)?.directReply ?? '').length,
        });
      }
    }

${anchor}`;

  if (!s.includes(anchor)) throw new Error('PRE_SEED_AFTER_RESOLVE anchor not found');
  s = s.replace(anchor, insert);

  fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
  console.log('[patched] route override v18b');
} else {
  console.log('[skip] route override already present');
}
