import fs from 'node:fs';

const files = {
  post: 'src/lib/iros/server/handleIrosReply.postprocess.ts',
  gate: 'src/lib/iros/server/llmGate.ts',
};

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
const must = (cond, label) => {
  if (!cond) throw new Error('Pattern not found: ' + label);
};

// ------------------------------------------------------------
// 1) handleIrosReply.postprocess.ts
// HQL時の slotPlanSeed を「話の芯」ではなく創造方向seedにする
// ------------------------------------------------------------
{
  const path = files.post;
  let s = read(path);

  if (!s.includes('HQL_SEED_SOURCE_CREATION_V17')) {
    const anchor = `  for (const obj of obsObjs) {
    buildObsLines(obj).forEach(push);
  }`;

    const insert = `  // HQL_SEED_SOURCE_CREATION_V17
  // hidden_question_landing / ethical_abundance_refusal のときは、
  // slotPlanSeedを「怒りの安定化」や「話の芯」ではなく、本のMuの創造方向seedにする。
  const hasEthicalAbundanceHql = shiftObjs.some((obj: any) => {
    const kind = normText(obj?.kind);
    const intent = normText(obj?.intent);
    const hiddenKind = normText(obj?.hiddenQuestionLandingKind);
    const line = normText(obj?.line);
    return (
      kind === 'hidden_question_landing' ||
      intent === 'answer_hidden_question' ||
      hiddenKind === 'ethical_abundance_refusal' ||
      /人の不安.*お金|きれいな言葉.*お金|誠実.*自由|豊かさ/u.test(line)
    );
  });

  if (hasEthicalAbundanceHql) {
    push('これは怒りを安定させる場面ではなく、人の不安をきれいな言葉で包み、お金へ変える構造への拒否を映す場面です。');
    push('拒んでいるのは豊かさそのものではなく、人の不安を燃料にして進む豊かさです。');
    push('ここではAI批判の是非や使い方ではなく、きれいな希望が売り物になる構造を見ます。');
    push('最後は、誠実さを失わずに自由や豊かさを生めるのか、創造の方向へ開く問いとして置きます。');
    return lines.join('\\\\n').trim();
  }

${anchor}`;

    must(s.includes(anchor), 'postprocess obs loop anchor');
    s = s.replace(anchor, insert);
    write(path, s);
    console.log('[patched]', path);
  } else {
    console.log('[skip]', path);
  }
}

// ------------------------------------------------------------
// 2) llmGate.ts
// HQL時の @GOAL を STABILIZE ではなく HIDDEN_QUESTION_LANDING にする
// ------------------------------------------------------------
{
  const path = files.gate;
  let s = read(path);

  if (!s.includes('HQL_LLM_GATE_GOAL_V17')) {
    const sigFrom = `const normGoal = (v: any): 'STABILIZE' | 'ADVANCE' | 'CLARIFY' | 'SAFE' => {`;
    const sigTo = `const normGoal = (v: any): 'STABILIZE' | 'ADVANCE' | 'CLARIFY' | 'SAFE' | 'HIDDEN_QUESTION_LANDING' => {`;

    must(s.includes(sigFrom), 'normGoal signature');
    s = s.replace(sigFrom, sigTo);

    const afterS = `    const s = String(v ?? '').trim().toLowerCase();`;
    const inject = `    const s = String(v ?? '').trim().toLowerCase();

    // HQL_LLM_GATE_GOAL_V17
    // hidden_question_landing / ethical_abundance_refusal は安定化ではなく、奥の問いへの着地として扱う。
    const metaAny: any = meta ?? {};
    const extraAny: any = metaAny?.extra ?? {};
    const ctxAny: any = extraAny?.ctxPack ?? metaAny?.ctxPack ?? {};
    const isHql =
      metaAny?.hiddenQuestionLanding === true ||
      extraAny?.hiddenQuestionLanding === true ||
      ctxAny?.hiddenQuestionLanding === true ||
      String(metaAny?.shiftKind ?? extraAny?.shiftKind ?? ctxAny?.shiftKind ?? '').trim() === 'hidden_question_landing' ||
      String(metaAny?.presentationKind ?? extraAny?.presentationKind ?? ctxAny?.presentationKind ?? '').trim() === 'ethical_abundance_refusal_hidden_question' ||
      String(metaAny?.resolvedAsk?.topic ?? extraAny?.resolvedAsk?.topic ?? ctxAny?.resolvedAsk?.topic ?? '').trim() === 'ethical_abundance_refusal';

    if (isHql) return 'HIDDEN_QUESTION_LANDING';`;

    must(s.includes(afterS), 'normGoal const s');
    s = s.replace(afterS, inject);

    s = s.replace(
      `goal === 'STABILIZE' || goal === 'SAFE'`,
      `goal === 'STABILIZE' || goal === 'SAFE' || goal === 'HIDDEN_QUESTION_LANDING'`
    );

    s = s.replace(
      `goal === 'SAFE'
      ? 4
      : isMeaningConfirm`,
      `goal === 'SAFE'
      ? 4
      : goal === 'HIDDEN_QUESTION_LANDING'
        ? 5
        : isMeaningConfirm`
    );

    write(path, s);
    console.log('[patched]', path);
  } else {
    console.log('[skip]', path);
  }
}

console.log('');
console.log('Done. Run: npm run typecheck');
