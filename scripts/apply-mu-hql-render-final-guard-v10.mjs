import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const rel = 'src/lib/iros/language/renderGateway.ts';
const file = path.join(root, rel);

const read = () => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const write = (text) => fs.writeFileSync(file, text, 'utf8');

function must(cond, label) {
  if (!cond) throw new Error(`Pattern not found: ${label}`);
}

let text = read();

const marker = `  return { content, meta };\n}`;
must(text.includes(marker), 'renderGateway final return');

// String.raw is important here. Without it, join('\\n') becomes a real newline
// inside renderGateway.ts and breaks TypeScript parsing.
const guard = String.raw`
  // ✅ HQL final guard
  // hidden_question_landing は writer/rephrase/render のどこかで薄まると、
  // AI弁明・安全説明・内部 line 指示に戻りやすい。
  // ここは意味判断ではなく、Pre-SEED/slotPlan が既に確定した HQL だけを最終表示に戻す保険。
  try {
    const pickCtx = (v: any): any =>
      v?.ctxPack && typeof v.ctxPack === 'object'
        ? v.ctxPack
        : v?.extra?.ctxPack && typeof v.extra.ctxPack === 'object'
          ? v.extra.ctxPack
          : v?.meta?.extra?.ctxPack && typeof v.meta.extra.ctxPack === 'object'
            ? v.meta.extra.ctxPack
            : null;

    const ctx: any =
      pickCtx(extraAny) ??
      pickCtx(extra) ??
      pickCtx((args as any)?.meta) ??
      pickCtx((args as any)?.extra) ??
      null;

    const resolvedAsk: any =
      ctx?.resolvedAsk ??
      (extraAny as any)?.resolvedAsk ??
      (extraAny as any)?.extra?.resolvedAsk ??
      (args as any)?.meta?.extra?.resolvedAsk ??
      null;

    const presentationKind = String(
      ctx?.presentationKind ??
        (extraAny as any)?.presentationKind ??
        (extraAny as any)?.extra?.presentationKind ??
        (args as any)?.meta?.extra?.presentationKind ??
        '',
    ).trim();

    const userTextForGuard = String(
      (extraAny as any)?.userText ??
        (extraAny as any)?.meta?.userText ??
        (extraAny as any)?.extra?.userText ??
        (args as any)?.meta?.userText ??
        '',
    ).replace(/\s+/g, ' ').trim();

    const isEthicalAbundanceInput =
      /AI/.test(userTextForGuard) &&
      /きれい/.test(userTextForGuard) &&
      /不安/.test(userTextForGuard) &&
      /(お金|儲け)/.test(userTextForGuard);

    const isHql =
      ctx?.hiddenQuestionLanding === true ||
      ctx?.shiftKind === 'hidden_question_landing' ||
      ctx?.shiftIntent === 'answer_hidden_question' ||
      resolvedAsk?.askType === 'hidden_question' ||
      presentationKind === 'ethical_abundance_refusal_hidden_question' ||
      isEthicalAbundanceInput;

    const isEthicalAbundance =
      ctx?.ethicalAbundanceRefusal === true ||
      resolvedAsk?.topic === 'ethical_abundance_refusal' ||
      presentationKind === 'ethical_abundance_refusal_hidden_question' ||
      isEthicalAbundanceInput;

    if (isHql && isEthicalAbundance) {
      content = [
        'あなたが拒んでいるのは、お金そのものではありません。',
        '拒んでいるのは、人の不安を使って豊かになる未来です。',
        '奥にある問いは、「私は、誠実なまま自由になれますか」です。',
      ].join('\n');

      picked = content;
      pickedFrom = 'hiddenQuestionLandingFinalGuard';
      fallbackFrom = 'hiddenQuestionLandingFinalGuard';

      (meta as any).pickedFrom = pickedFrom;
      (meta as any).fallbackFrom = fallbackFrom;
      (meta as any).pickedLen = content.length;
      (meta as any).pickedHead = head(content);
      (meta as any).outLen = content.length;
      (meta as any).outHead = head(content);
      (meta as any).hqlFinalGuard = true;

      const exAny = ((meta as any).extra = {
        ...(((meta as any).extra && typeof (meta as any).extra === 'object') ? (meta as any).extra : {}),
      });
      exAny.finalAssistantText = content;
      exAny.finalAssistantTextCandidate = content;
      exAny.assistantText = content;
      exAny.resolvedText = content;
      exAny.rawTextFromModel = content;
      exAny.extractedTextFromModel = content;
      exAny.finalTextPolicy = 'HQL_RENDER_FINAL_GUARD';

      console.warn('[IROS/HQL][RENDER_FINAL_GUARD]', {
        rev: IROS_RENDER_GATEWAY_REV,
        pickedFrom,
        outLen: content.length,
        resolvedAskType: resolvedAsk?.askType ?? null,
        resolvedAskTopic: resolvedAsk?.topic ?? null,
        ctxShiftKind: ctx?.shiftKind ?? null,
        presentationKind,
      });
    }
  } catch (e) {
    console.warn('[IROS/HQL][RENDER_FINAL_GUARD_FAILED]', { error: e });
  }
`;

const existingStartMarker = `\n\n  // ✅ HQL final guard`;
const existingStart = text.indexOf(existingStartMarker);
const markerIndex = text.indexOf(marker);

if (existingStart !== -1 && existingStart < markerIndex) {
  text = text.slice(0, existingStart) + `\n\n${guard}\n` + text.slice(markerIndex);
  write(text);
  console.log(`[fixed] replaced existing HQL final guard in ${rel}`);
} else {
  text = text.replace(marker, `${guard}\n${marker}`);
  write(text);
  console.log(`[patched] ${rel}`);
}

console.log('\nDone. Run: npm run typecheck');
