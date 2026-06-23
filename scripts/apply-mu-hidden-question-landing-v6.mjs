// scripts/apply-mu-hidden-question-landing-v6.mjs
// Patch the clarify/question route so hidden_question is not downgraded to truth_structure.

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const target = 'src/lib/iros/slotPlans/normalChat.ts';

function abs(rel) {
  return path.join(root, rel);
}

function read(rel) {
  return fs.readFileSync(abs(rel), 'utf8').replace(/\r\n/g, '\n');
}

function write(rel, text) {
  fs.writeFileSync(abs(rel), text, 'utf8');
}

function patchNormalChat() {
  let text = read(target);

  if (text.includes('shouldHiddenQuestionLandingInClarify')) {
    console.log('[skip] normalChat clarify hidden question patch already applied');
    return;
  }

  const anchor = "\n  const directAnswerRequested =\n";

  const insert = `
    const shouldHiddenQuestionLandingInClarify =
      resolvedAskType === 'hidden_question' ||
      resolvedAskTopic === 'ethical_abundance_refusal' ||
      isEthicalAbundanceRefusalInput(instructionText) ||
      isEthicalAbundanceRefusalInput(seedText) ||
      isEthicalAbundanceRefusalInput(normalizedUserText) ||
      isEthicalAbundanceRefusalInput(normalizedTargetText);

    if (shouldHiddenQuestionLandingInClarify) {
      const hiddenKind =
        resolvedAskTopic === 'ethical_abundance_refusal' ||
        isEthicalAbundanceRefusalInput(instructionText) ||
        isEthicalAbundanceRefusalInput(seedText) ||
        isEthicalAbundanceRefusalInput(normalizedUserText) ||
        isEthicalAbundanceRefusalInput(normalizedTargetText)
          ? 'ethical_abundance_refusal'
          : 'intention_refusal';

      const hiddenSeedText =
        hiddenKind === 'ethical_abundance_refusal'
          ? [
              '表面的なAI批判として扱わない。',
              '拒んでいる未来: 人の不安を使って豊かになる未来。',
              '奥の問い: 私は、誠実なまま自由になれますか。',
              'AI側の姿勢表明、「筋が通っています」、「何に使うか」で閉じない。',
              '行動提案・説明羅列・質問返しをしない。',
            ].join('\\n')
          : seedText;

      return [
        obs,
        {
          key: 'SHIFT',
          role: 'assistant',
          style: 'neutral',
          content: m('SHIFT', {
            kind: 'hidden_question_landing',
            intent: 'answer_hidden_question',
            hint: 'hidden_question_landing_v1',
            line: '拒んでいる未来を名付け、その奥の問いで閉じる',
            source: 'clarify_hidden_question',
            hiddenQuestionLandingKind: hiddenKind,
            contract: [
              'do_not_treat_as_surface_criticism',
              'name_refused_future',
              'split_money_from_anxiety_extraction',
              'name_core_question',
              'no_ai_defense',
              'no_action_plan',
              'no_question_end',
              'plain_words',
            ],
            rules: {
              answer_user_meaning: false,
              answer_hidden_question: true,
              name_refused_future: hiddenKind === 'ethical_abundance_refusal',
              name_core_question: true,
              no_ai_defense: true,
              no_safe_posture_only: true,
              no_action_plan: true,
              no_checklist: true,
              output_only: true,
              no_bullets: true,
              lines_max: 5,
            },
            allow: {
              concrete_reply: false,
              short_reply_ok: false,
            },
            seed_text: hiddenSeedText,
          }),
        },
        safe,
        buildNextHintSlot({
          userText,
          laneKey: lane,
          flowDelta: delta,
        }),
      ];
    }
`;

  if (!text.includes(anchor)) {
    throw new Error('Anchor not found: directAnswerRequested in normalChat clarify route');
  }

  text = text.replace(anchor, insert + anchor);
  write(target, text);
  console.log('[patched] normalChat clarify route catches hidden_question_landing');
}

patchNormalChat();
console.log('\nDone. Run: npm run typecheck');
