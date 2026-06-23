import fs from 'node:fs';

const files = {
  types: 'src/lib/iros/server/preseed/universal/types.ts',
  resolve: 'src/lib/iros/server/preseed/universal/resolveUniversalPreSeed.ts',
  route: 'src/app/api/agent/iros/reply/route.ts',
};

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
const must = (cond, label) => {
  if (!cond) throw new Error('Pattern not found: ' + label);
};

// ------------------------------------------------------------
// 1) types.ts
// ------------------------------------------------------------
{
  const path = files.types;
  let s = read(path);

  if (!s.includes(`| 'hql_creation_landing'`)) {
    s = s.replace(
      `    | 'memory_recall'\n    | 'normal_chat'`,
      `    | 'memory_recall'\n    | 'hql_creation_landing'\n    | 'normal_chat'`
    );

    s = s.replace(
      `  | 'normal_writer'\n  | 'direct_reply'`,
      `  | 'normal_writer'\n  | 'hql_creation_landing'\n  | 'direct_reply'`
    );

    write(path, s);
    console.log('[patched]', path);
  } else {
    console.log('[skip]', path);
  }
}

// ------------------------------------------------------------
// 2) resolveUniversalPreSeed.ts
// normal_chat に落ちる前に ethical_abundance_refusal を専用route化
// ------------------------------------------------------------
{
  const path = files.resolve;
  let s = read(path);

  if (!s.includes('HQL_CREATION_LANDING_ROUTE_V18')) {
    const anchor = `  const memoryIntent = classifyMemoryIntent(userText);

  if (memoryIntent === 'normal_chat' || memoryIntent === 'unknown') {
    return null;
  }`;

    const insert = `  const memoryIntent = classifyMemoryIntent(userText);

  // HQL_CREATION_LANDING_ROUTE_V18
  // normal_chat に落とす前に、本のMu第1巻の入口になる HQL を専用ルートへ分離する。
  const ethicalAbundanceText = userText.replace(/\\s+/g, ' ').trim();
  const isEthicalAbundanceHql =
    /(AI|きれいごと|綺麗事|自由|好きなことで働く|好きなことで稼ぐ)/u.test(ethicalAbundanceText) &&
    /(人の不安|不安を.*使|不安を.*見つけ|きれいな言葉|綺麗な言葉|お金|儲け|買わせ|売り物)/u.test(ethicalAbundanceText) &&
    /(AIも同じ|AI.*同じ|最後はお金|お金に変える|刺激して.*お金|不安.*お金)/u.test(ethicalAbundanceText);

  if (isEthicalAbundanceHql) {
    const directReply = [
      '疑っているのは、AIそのものというより、人の不安を見つけて、きれいな言葉に変えて、最後にお金へ流す構造です。',
      '',
      'だから「自由に生きよう」という言葉も、希望ではなく、誰かの弱さを材料にする言葉に聞こえてしまう。',
      '',
      '本当に問われているのは、そこに飲まれずに、誠実なまま自由や豊かさを生めるのか、ということです。'
    ].join('\\n');

    return {
      kind: 'hql_creation_landing',
      memoryIntent: 'normal_chat',
      memorySpace: 'normal',
      route: 'hql_creation_landing',

      confidence: 0.96,

      resolvedTarget: null,
      resolvedRelation: null,

      sourceAuthority: 'user_text',
      sourceKind: 'ethical_abundance_refusal',
      sourceId: null,
      sourceText: userText,

      seedText:
        'HQL_CREATION_LANDING_ROUTE_V18 (DO NOT OUTPUT):\\n' +
        'route=hql_creation_landing\\n' +
        'これは通常相談ではなく、本のMu第1巻の hidden_question_landing として返す。\\n' +
        '人の不安をきれいな言葉で包み、お金へ流す構造への拒否を映す。\\n' +
        '最後は、誠実なまま自由や豊かさを生めるのかという問いへ着地する。',

      writerInput: null,
      directReply,

      shouldUsePreSeedWriter: false,
      shouldBypassNormalWriter: true,
      shouldBypassRephrase: true,
      shouldSuppressHistoryForWriter: true,
      shouldSuppressSimilarFlow: true,
      shouldSuppressSlotPlan: true,
      shouldSuppressMemoryDelta: true,
      shouldSuppressNormalResonance: true,

      shouldOpenContextThread: false,
      contextThreadCode: null,

      ctxPackPatch: {
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
          source: 'hql_creation_landing_route_v18',
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
          source: 'hql_creation_landing_route_v18',
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
        reason: 'ethical_abundance_refusal_hidden_question_landing',
        matchedPattern: 'HQL_CREATION_LANDING_ROUTE_V18',
        routeReason: 'hql_creation_landing_bypasses_normal_writer_and_rephrase',
      },
    };
  }

  if (memoryIntent === 'normal_chat' || memoryIntent === 'unknown') {
    return null;
  }`;

    must(s.includes(anchor), 'resolve memoryIntent normal_chat anchor');
    s = s.replace(anchor, insert);

    write(path, s);
    console.log('[patched]', path);
  } else {
    console.log('[skip]', path);
  }
}

// ------------------------------------------------------------
// 3) route.ts
// hql_creation_landing を direct_reply と同じ出口へ通す
// ------------------------------------------------------------
{
  const path = files.route;
  let s = read(path);

  if (!s.includes('PRE_SEED_HQL_CREATION_LANDING_RETURN_V18')) {
    const from = `(preSeedDecision?.route === 'direct_reply' || preSeedDecision?.route === 'clarify') &&
      preSeedDecision.shouldBypassWriter &&
      preSeedDecision.directReply`;

    const to = `(
        preSeedDecision?.route === 'direct_reply' ||
        preSeedDecision?.route === 'clarify' ||
        // PRE_SEED_HQL_CREATION_LANDING_RETURN_V18
        preSeedDecision?.route === 'hql_creation_landing'
      ) &&
      preSeedDecision.shouldBypassWriter &&
      preSeedDecision.directReply`;

    must(s.includes(from), 'route direct_reply condition');
    s = s.replace(from, to);

    write(path, s);
    console.log('[patched]', path);
  } else {
    console.log('[skip]', path);
  }
}

console.log('');
console.log('Done. Run: npm run typecheck');
