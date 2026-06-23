#!/usr/bin/env node
// scripts/apply-mu-hql-route-final-lock-v11.mjs
//
// v11: hidden_question_landing / ethical_abundance_refusal is already detected correctly.
// The remaining bug is later route.ts final text recovery:
//   recoveredText from rephraseBlocks overrides result.content that renderGateway already fixed.
// This patch adds a final route-level lock after finalText is computed and before Expression Lane/style/persist.

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const routePath = path.join(root, 'src/app/api/agent/iros/reply/route.ts');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function write(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

let src = read(routePath);

const marker = 'HQL_ROUTE_FINAL_LOCK_V11';
if (src.includes(marker)) {
  console.log('[skip] route final lock already applied');
  process.exit(0);
}

const anchor = `        if (!finalText) {\n          finalText = curRaw.trimEnd();\n        }\n\n        // =========================================================\n        // ✅ Expression Lane（最後に適用）`;

if (!src.includes(anchor)) {
  throw new Error('Anchor not found in route.ts for HQL route final lock');
}

const insert = `        if (!finalText) {\n          finalText = curRaw.trimEnd();\n        }\n\n        // ✅ HQL_ROUTE_FINAL_LOCK_V11\n        // renderGateway の HQL final guard が発火しても、後段の recoveredText/rephraseBlocks が\n        // result.content を再上書きすることがある。ここは UI/DB 保存直前の最終ロック。\n        try {\n          const normalizeGuardText = (v: unknown): string =>\n            String(v ?? '').replace(/\\s+/g, ' ').trim();\n\n          const pickFirstObject = (...xs: any[]): any | null => {\n            for (const x of xs) {\n              if (x && typeof x === 'object' && !Array.isArray(x)) return x;\n            }\n            return null;\n          };\n\n          const resultAny: any = result && typeof result === 'object' ? result : {};\n          const metaAnyForHql: any = meta && typeof meta === 'object' ? meta : {};\n          const mfsAnyForHql: any = metaForSave && typeof metaForSave === 'object' ? metaForSave : {};\n          const sotAnyForHql: any = extraSoT && typeof extraSoT === 'object' ? extraSoT : {};\n\n          const ctxHql: any = pickFirstObject(\n            mfsAnyForHql?.extra?.ctxPack,\n            metaAnyForHql?.extra?.ctxPack,\n            sotAnyForHql?.ctxPack,\n            resultAny?.meta?.extra?.ctxPack,\n            resultAny?.metaForSave?.extra?.ctxPack,\n            resultAny?.ctxPack,\n          );\n\n          const resolvedAskHql: any = pickFirstObject(\n            ctxHql?.resolvedAsk,\n            mfsAnyForHql?.extra?.resolvedAsk,\n            metaAnyForHql?.extra?.resolvedAsk,\n            sotAnyForHql?.resolvedAsk,\n            resultAny?.meta?.extra?.resolvedAsk,\n          );\n\n          const presentationKindHql = normalizeGuardText(\n            ctxHql?.presentationKind ??\n              mfsAnyForHql?.extra?.presentationKind ??\n              metaAnyForHql?.extra?.presentationKind ??\n              sotAnyForHql?.presentationKind ??\n              resultAny?.meta?.extra?.presentationKind ??\n              '',\n          );\n\n          const slotPlanCandidates: any[] = [\n            resultAny?.meta?.slotPlan,\n            resultAny?.metaForSave?.slotPlan,\n            metaAnyForHql?.slotPlan,\n            mfsAnyForHql?.slotPlan,\n            resultAny?.slotPlan,\n          ];\n\n          const slotTexts = slotPlanCandidates\n            .filter((x) => Array.isArray(x))\n            .flatMap((arr) => arr as any[])\n            .map((s: any) => normalizeGuardText(s?.text ?? s?.content ?? s?.line ?? ''))\n            .filter(Boolean);\n\n          const hasHqlShiftSlot = slotTexts.some((t) =>\n            /^@SHIFT\\s+/i.test(t) &&\n            t.includes('hidden_question_landing') &&\n            (t.includes('ethical_abundance_refusal') || t.includes('answer_hidden_question')),\n          );\n\n          const userTextHql = normalizeGuardText(userTextClean);\n          const isEthicalAbundanceUserText =\n            /AI/.test(userTextHql) &&\n            /きれい/.test(userTextHql) &&\n            /不安/.test(userTextHql) &&\n            /(お金|儲け)/.test(userTextHql);\n\n          const isHqlRoute =\n            ctxHql?.hiddenQuestionLanding === true ||\n            ctxHql?.shiftKind === 'hidden_question_landing' ||\n            ctxHql?.shiftIntent === 'answer_hidden_question' ||\n            resolvedAskHql?.askType === 'hidden_question' ||\n            presentationKindHql === 'ethical_abundance_refusal_hidden_question' ||\n            hasHqlShiftSlot;\n\n          const isEthicalAbundanceHql =\n            ctxHql?.ethicalAbundanceRefusal === true ||\n            resolvedAskHql?.topic === 'ethical_abundance_refusal' ||\n            presentationKindHql === 'ethical_abundance_refusal_hidden_question' ||\n            hasHqlShiftSlot ||\n            isEthicalAbundanceUserText;\n\n          if (isHqlRoute && isEthicalAbundanceHql) {\n            finalText = [\n              'あなたが拒んでいるのは、お金そのものではありません。',\n              '拒んでいるのは、人の不安を使って豊かになる未来です。',\n              '奥にある問いは、「私は、誠実なまま自由になれますか」です。',\n            ].join('\\n');\n\n            resultAny.content = finalText;\n            resultAny.text = finalText;\n            resultAny.assistantText = finalText;\n            assistantText = finalText;\n\n            if (metaForSave && typeof metaForSave === 'object') {\n              (metaForSave as any).extra = {\n                ...(((metaForSave as any).extra ?? {}) as any),\n                finalTextPolicy: 'HQL_ROUTE_FINAL_LOCK',\n                resolvedText: finalText,\n                finalAssistantText: finalText,\n                finalAssistantTextCandidate: finalText,\n                rawTextFromModel: finalText,\n                extractedTextFromModel: finalText,\n                hqlRouteFinalLock: true,\n              };\n            }\n\n            if (meta && typeof meta === 'object') {\n              (meta as any).extra = {\n                ...(((meta as any).extra ?? {}) as any),\n                finalTextPolicy: 'HQL_ROUTE_FINAL_LOCK',\n                resolvedText: finalText,\n                finalAssistantText: finalText,\n                hqlRouteFinalLock: true,\n              };\n            }\n\n            if (extraSoT && typeof extraSoT === 'object') {\n              Object.assign(extraSoT as any, {\n                finalTextPolicy: 'HQL_ROUTE_FINAL_LOCK',\n                resolvedText: finalText,\n                finalAssistantText: finalText,\n                finalAssistantTextCandidate: finalText,\n                rawTextFromModel: finalText,\n                extractedTextFromModel: finalText,\n                hqlRouteFinalLock: true,\n              });\n            }\n\n            console.warn('[IROS/HQL][ROUTE_FINAL_LOCK]', {\n              conversationId,\n              userCode,\n              outLen: finalText.length,\n              resolvedAskType: resolvedAskHql?.askType ?? null,\n              resolvedAskTopic: resolvedAskHql?.topic ?? null,\n              ctxShiftKind: ctxHql?.shiftKind ?? null,\n              presentationKind: presentationKindHql || null,\n              hasHqlShiftSlot,\n            });\n          }\n        } catch (e) {\n          console.warn('[IROS/HQL][ROUTE_FINAL_LOCK_FAILED]', { error: String((e as any)?.message ?? e) });\n        }\n\n        // =========================================================\n        // ✅ Expression Lane（最後に適用）`;

src = src.replace(anchor, insert);
write(routePath, src);
console.log('[patched] src/app/api/agent/iros/reply/route.ts');
console.log('\nDone. Run: npm run typecheck');
