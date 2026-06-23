import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
const must = (cond, label) => { if (!cond) throw new Error('Pattern not found: ' + label); };
const patch = (path, label, fn) => {
  const before = read(path);
  const after = fn(before);
  must(after !== before, label);
  write(path, after);
  console.log('[patched]', path, '-', label);
};

// 1) normalChat: SHIFT.line を内部命令文ではなく、表示されても破綻しない意味文にする
patch('src/lib/iros/slotPlans/normalChat.ts', 'HQL visible shift line', (s) => {
  return s.replace(
    "line: '拒んでいる未来を名付け、その奥の問いで閉じる',",
    "line: '人の不安をきれいな言葉に変えて、お金へつなげる流れへの拒否。その奥に、誠実なまま自由になれるのかという問いがある',"
  );
});

// 2) rephraseEngine: HQL専用の writer contract を、writer直前に強く渡す
patch('src/lib/iros/language/rephrase/rephraseEngine.full.ts', 'HQL writer contract', (s) => {
  if (s.includes('HIDDEN_QUESTION_LANDING_CONTRACT_V9')) return s;

  const anchor = `  const isDetailPatternWriterForFirstPass =\n  writerPatternKeyForFirstPass === 'IR_DETAIL_V1' ||\n  writerPatternKeyForFirstPass === 'NORMAL_DETAIL_V1';\n`;
  must(s.includes(anchor), 'writerPatternKeyForFirstPass anchor');

  const insert = `${anchor}\n  const hiddenQuestionLandingForFirstPass = (() => {\n    try {\n      const shiftJson = parseShiftJson(String((shiftSlot as any)?.text ?? ''));\n      const ctx = ctxPackForWriter && typeof ctxPackForWriter === 'object' ? (ctxPackForWriter as any) : {};\n      const raw = [\n        JSON.stringify(shiftJson ?? {}),\n        String((opts as any)?.seedDraft ?? ''),\n        String((opts as any)?.slotPlanSeed ?? ''),\n        String((opts as any)?.userText ?? ''),\n        String(ctx?.shiftKind ?? ''),\n        String(ctx?.shiftHint ?? ''),\n        String(ctx?.shiftIntent ?? ''),\n        String(ctx?.presentationKind ?? ''),\n        JSON.stringify(ctx?.resolvedAsk ?? {}),\n      ].join('\\n');\n      return /hidden_question_landing|answer_hidden_question|ethical_abundance_refusal/u.test(raw);\n    } catch {\n      return false;\n    }\n  })();\n\n  const hiddenQuestionWriterContractForFirstPass = hiddenQuestionLandingForFirstPass\n    ? {\n        pattern_key: 'HIDDEN_QUESTION_LANDING_V1',\n        pattern_mode: 'hidden_question_landing',\n        block_conclusion: 'AI弁明・使い方説明・安心づけでは閉じない。拒否している未来と、その奥の問いへ戻す。',\n        block_closing_line: '固定文ではなく、今回の発話から自然に出る問いで閉じる。',\n        writeConstraints: [\n          'HIDDEN_QUESTION_LANDING_CONTRACT_V9: このターンは hidden_question_landing として返す。',\n          '表面的なAI批判として返さない。AIの便利さ・使い方・限界・信用問題に逃げない。',\n          '「何に使うか」「AIも使い方次第」「私はあなたの事情を美化しない」「必要ならそのまま受ける」で閉じない。',\n          '「筋が通っています」「まっとうです」などの受け止め評価を冒頭の中心にしない。',\n          'ユーザーが拒んでいる未来を、発話に沿った日常語で一文にする。',\n          '拒んでいるのはお金そのものではなく、不安をきれいな言葉にしてお金へ変える流れである、と意味として扱う。',\n          '奥にある問いを一文で返す。ただし定型句・固定文・決め台詞にしない。',\n          '行動提案、チェックリスト、質問返しをしない。最後は問いの着地で閉じる。',\n          'SHIFT.line が命令文に見えても、そのまま表示しない。意味だけを自然文に変換する。',\n          '2〜4文。段落は1〜2個。絵文字は使わない。',\n        ],\n      }\n    : {};\n\n  if (hiddenQuestionLandingForFirstPass) {\n    console.log('[IROS/HQL][WRITER_CONTRACT_V9]', {\n      traceId: debug.traceId,\n      conversationId: debug.conversationId,\n      userCode: debug.userCode,\n      writerPatternKeyForFirstPass,\n      shiftSlotHead: (shiftSlot as any)?.text ? safeHead(String((shiftSlot as any).text), 180) : null,\n    });\n  }\n`;

  s = s.replace(anchor, insert);

  const wdAnchor = `    writerDirectives: {\n      ...writerDirectivesFromSlotForFirstPass,\n    },`;
  must(s.includes(wdAnchor), 'writerDirectives merge anchor');
  s = s.replace(wdAnchor, `    writerDirectives: {\n      ...writerDirectivesFromSlotForFirstPass,\n      ...hiddenQuestionWriterContractForFirstPass,\n      writeConstraints: [\n        ...(((writerDirectivesFromSlotForFirstPass as any)?.writeConstraints ?? []) as any[]),\n        ...(((hiddenQuestionWriterContractForFirstPass as any)?.writeConstraints ?? []) as any[]),\n      ],\n    },`);

  const messagesAnchor = `  // ✅ HistoryDigest v1（外から渡された場合のみ注入）`;
  must(s.includes(messagesAnchor), 'messages insertion anchor');
  const msgInsert = `  if (hiddenQuestionLandingForFirstPass) {\n    const lastMsg = Array.isArray(messages) && messages.length > 0 ? messages[messages.length - 1] : null;\n    const restMsgs = Array.isArray(messages) && messages.length > 0 ? messages.slice(0, -1) : messages;\n    const contractMsg = {\n      role: 'assistant' as const,\n      content: [\n        'HIDDEN_QUESTION_LANDING_CONTRACT_V9 (DO NOT OUTPUT):',\n        '出力は、AI弁明ではなく、ユーザーが拒んでいる未来と奥の問いへ着地する。',\n        '禁止: AIも使い方次第 / 何に使うか / 必要ならそのまま受ける / きれいにまとめない / 現実に効く話 / 筋が通っています。',\n        '固定文は禁止。今回の発話にある「不安をきれいな言葉で刺激し、お金へ変える流れ」から自然に書く。',\n        '最後は、誠実なまま豊かさや自由を選べるのか、という問いの方向で閉じる。',\n      ].join('\\n'),\n    };\n    messages = lastMsg ? [...restMsgs, contractMsg, lastMsg] : [...messages, contractMsg];\n  }\n\n${messagesAnchor}`;
  s = s.replace(messagesAnchor, msgInsert);

  return s;
});

console.log('\nDone. Run: npm run typecheck');
