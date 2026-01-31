
// src/lib/iros/slotPlans/irDiagnosis.ts
// iros — ir診断 slotPlan builder
//
// 目的：orchestrator.ts の ir診断ターンで slotsArr を必ず埋めて
// normalChat/flagReply/counsel の落下を防ぐ。
// ※ここは「診断の“話し方の骨格”」だけを作る（意味の判断は増やさない）

export type IrDiagnosisSlotPlan = {
  slots: Array<{ key: string; text: string }>;
  slotPlanPolicy: 'FINAL';
};

function pickLabelFromUserText(userText: string): string {
  const t = String(userText ?? '').trim();
  if (!t) return 'self';

  // 例: "ir診断 自分" / "ir診断 ひろみの母"
  if (t.startsWith('ir診断')) {
    const rest = t.slice('ir診断'.length).trim();
    if (rest) return rest;
  }
  return 'self';
}

export function buildIrDiagnosisSlotPlan(args: {
  userText: string;
  targetLabel?: string | null;
}) {
  const raw = String(args.userText ?? '').trim();
  const label = String(args.targetLabel ?? '').trim() || pickLabelFromUserText(raw);

  // ✅ “seed” は必ず非空にする（LLM_GATE が空seedで normalBase へ落ちるのを防ぐ）
  const seed = [
     `ir診断 ${label}`,
     '',
     '観測対象：' + label,
     '出力：フェーズ／位相／深度（S/R/C/I/T）＋短い意識状態＋短いメッセージ',
     '',
     '入力：' + (raw || `(none)`),
  ].join('\n');

  return {
     slotPlanPolicy: 'FINAL',
     slots: [
        { key: 'SEED_TEXT', text: seed },
     ],
  };
}

