// src/lib/iros/expression/exprDirectiveV1.ts
//
// e_turn（= eメタ）で「文章構成」と「リメイク/I層返し優先度」を Writer に伝えるための
// “短い内部指示” を生成する。
// - 構造（Depth/Q/Phase/Lane/slotPlan）には一切触れない。
// - 本文に露出させない（system注入専用想定）。
// - 長文化させない（最大 ~8行）。

export type ETurn = 'e1' | 'e2' | 'e3' | 'e4' | 'e5';

export type ExprDirectiveInput = {
  e_turn: ETurn | null;
  polarity?: 'yin' | 'yang' | null;
  flowDelta?: 'FORWARD' | 'RETURN' | string | null;
  returnStreak?: number | null;
  confidence?: number | null;
};

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function buildExprDirectiveV1(input: ExprDirectiveInput): string | null {
  const e = input.e_turn ?? null;
  const pol = input.polarity ?? null;
  const ret = (input.flowDelta ?? '').toString().toUpperCase() === 'RETURN';
  const streak = Math.max(0, Number(input.returnStreak ?? 0) || 0);
  const conf = clamp01(Number(input.confidence ?? 0) || 0);

  // 信頼が低い時は「強い演出」をしない（安全）
  // ✅ 0.55 も mild 扱い（境界を含める）
  const mild = conf > 0 && conf <= 0.55;

  if (!e) return null;

  const lines: string[] = [];

  // 既存ログの見た目と合わせる（露出禁止ヘッダ統一）
  lines.push('【DIRECTIVE_V1（露出禁止）】本文に含めない。構造(Depth/Q/Phase/Lane/slotPlan)は絶対に変更しない。');

  // ★今回の課題に直撃する指示：抽象語を減らし、ユーザー語彙に寄せる
  lines.push('語彙：日常語優先。抽象語（内側/外側/未回収/決着/構造/到着など）は原則使わず、使うなら言い換えて説明する。');
  lines.push('方針：ユーザーの言葉を拾って言い換え→本文。比喩は最小、短い文で通す。');

  // 共通：リメイク優先（ただし短く）
  lines.push('優先：言い換え/リメイク語を先に作り、そこから本文を組み立てる（同語反復を避ける）。');

  // RETURNが続く時：つなぎを厚くし、詰問を避ける
  if (ret && streak >= 1) {
    lines.push('会話接続：RETURN傾向。断定や詰問を避け、前の空気を受けて1歩だけ前へつなぐ。質問は0〜1。');
  }

  // e_turn別：文章構成の重み
  switch (e) {
    case 'e1':
      lines.push('構成：静かに整える。短めの2〜4段落。結論を急がず「いま何が引っかかってるか」を1点に置く。');
      break;

    case 'e2':
      lines.push('構成：圧を上げない。「言いたいけど言えてない/選びたくないけど選んだ」など“選べる言い換え”で返してから本文へ。');
      break;

    case 'e3':
      lines.push('構成：散りを束ねる。①受ける→②分ける→③小さい確定、の順。段落は短く、1文ずつ前へ。');
      break;

    case 'e4':
      lines.push('構成：安全最優先。刺激語を避け、速度を落として短い文で。安心の前提→次の1文、まで。');
      break;

    case 'e5':
      lines.push('構成：空虚/熱に寄せすぎない。具体語を拾って“芯”を1つ通す（抽象語で締めない）。');
      break;
  }

  // polarity補正（軽く）
  if (pol === 'yin') lines.push('トーン：yin寄り。落ち着き・余白・保護。断言より受容。');
  if (pol === 'yang') lines.push('トーン：yang寄り。前進の芯は出すが、押し切らない。');

  // mild（自信が低い）なら、強い演出を抑制
  if (mild) lines.push('注意：confidence低め。断定/深掘りは避け、言い換えも1候補まで。');

  // 最大8行くらいに丸める（先頭含む）
  const trimmed = lines.slice(0, 8);
  return trimmed.join('\n').trim();
}
