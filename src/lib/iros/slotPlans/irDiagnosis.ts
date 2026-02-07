// src/lib/iros/slotPlans/irDiagnosis.ts
// iros — ir診断 slotPlan builder
//
// 目的：orchestrator.ts の ir診断ターンで slotsArr を必ず埋めて
// normalChat/flagReply/counsel の落下を防ぐ。
// ※ここは「診断の“話し方の骨格”」だけを作る（意味の判断は増やさない）
//
// 重要：SLOT_TEXT_EMPTY を避けるため、slot.text は
// - 内部マーカー（@OBS など）に依存しない
// - “可視テキスト” を必ず含む
// を徹底する。

export type IrDiagnosisSlotPlan = {
  slots: Array<{ key: string; text: string }>;
  slotPlanPolicy: 'FINAL';
};

function normalizeLabel(s: string): string {
  const t = String(s ?? '').trim();
  if (!t) return 'self';
  // 改行や過剰な空白を抑制（ログ/seed破壊防止）
  return t.replace(/\s+/g, ' ').slice(0, 80) || 'self';
}

function pickLabelFromUserText(userText: string): string {
  const t = String(userText ?? '').trim();
  if (!t) return 'self';

  // 例: "ir診断 自分" / "ir診断 ひろみの母"
  if (t.startsWith('ir診断')) {
    const rest = t.slice('ir診断'.length).trim();
    if (rest) return normalizeLabel(rest);
  }
  return 'self';
}

function normalizeUserText(s: string): string {
  const t = String(s ?? '').trim();
  if (!t) return '';
  // ここでも改行を潰しすぎない（入力の形を残す）が、過度な連続改行は抑える
  return t.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n').slice(0, 800);
}

export function buildIrDiagnosisSlotPlan(args: { userText: string; targetLabel?: string | null }): IrDiagnosisSlotPlan {
  const raw = normalizeUserText(args.userText);
  const label = normalizeLabel(String(args.targetLabel ?? '').trim()) || pickLabelFromUserText(raw);

  // ✅ “可視テキスト” を最初から入れる（SLOT_TEXT_EMPTY回避）
  // ※ここでは診断結果そのものを作らない。あくまで「出力枠」と「観測対象の固定」だけ。
  const visibleSeed = [
    `ir診断：${label}`,
    `観測対象：${label}`,
    raw ? `入力：${raw}` : '入力：(none)',
  ].join('\n');

  // ✅ 出力フォーマットを固定（断定/説教/長文を誘発しない）
  const formatGuide = [
    '出力フォーマット（固定）：',
    '1) フェーズ：Seed/Forming/Reconnect/Create/Inspire/Impact（いずれか）',
    '2) 位相：Inner / Outer（いずれか）',
    '3) 深度：S/R/C/I/T のいずれか（例：I1, C2 など）',
    '4) 意識状態：短文（1行）',
    '5) メッセージ：短文（1〜2行）',
  ].join('\n');

  // ✅ 制約：判断しない／確定しない（骨格だけ）
  const constraints = [
    '制約（固定）：',
    '・断定しない（推測や決めつけを避ける）',
    '・説明しすぎない（講義/手順/長いチェックリストを避ける）',
    '・ユーザーの入力に沿った「状態提示」に留める',
  ].join('\n');

  return {
    slotPlanPolicy: 'FINAL',
    // NOTE: key 名は downstream の「usedSlots 判定」に影響し得るので、
    // 既存でよく使うキー体系（OBS/SHIFT/NEXT/SAFE）に寄せる。
    slots: [
      { key: 'OBS', text: visibleSeed },
      { key: 'SHIFT', text: formatGuide },
      { key: 'SAFE', text: constraints },
    ],
  };
}
