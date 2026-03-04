// src/lib/iros/conversation/normalBase.ts
// iros — Normal Base Conversation (EMERGENCY ONLY)
//
// 新憲法 適用版（全文書き換え）
//
// 目的（再定義）
// - Normal Base は「通常会話の土台」ではない
// - “航海士（writer）”が呼べない/呼んではいけない状況でのみ使う
// - つまり、EMPTY_LIKE_TEXT / 旧fallback / 異常系の「非常用」
//
// 原則
// - 判断はしない（Deterministic）
// - LLMは呼ばない（ここで喋らせると旧人格へ戻る事故になる）
// - user-facing は短く、未決にしないが、誘導もしない
//
// 注意
// - 無言アクト / FORWARD の判断はここではしない（上位の SpeechPolicy / Gate の責務）
// - renderEngine / rephraseEngine は使わない
// - 生成後の解析・分類は別レイヤで行う

type NormalBaseResult = {
  text: string;
  meta: { source: 'normal_base' };
};

// ---- utils

function normalizeOutput(text: string): string {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const sliced = lines.slice(0, 4);
  const joined = sliced.join('\n');
  return joined.length > 240 ? joined.slice(0, 240) : joined;
}

// 入力から軽く分岐するが「判断」はしない（安全な表現選択のみ）
function pickEmergencyLine(userText: string): string {
  const t = String(userText ?? '').trim();

  // 1) ほぼ空/短すぎ/記号のみ（上位で落ちてくる想定）
  // ⚠️ “……” は返さない：dots-only は render で空扱いにされやすい
  if (!t || t.length < 2 || /^[\s\W_]+$/u.test(t)) {
    return '受け取った。';
  }

  // 2) 疲労/沈黙っぽい
  if (/(眠|ねむ|疲|しんど|だる|つら|無理|限界)/u.test(t)) {
    return '受け取った。\nいまは、それで十分。🪔';
  }

  // 3) 強い不安/動揺っぽい
  if (/(怖|こわ|不安|焦|やば|助けて|無理|詰んだ|終わ|消え)/u.test(t)) {
    return 'ここにいる。\n言葉は、落とさない。🪔';
  }

  // 4) 相談/問いっぽいが、ここでは答えない（誘導もしない）
  if (/[？?]/.test(t) || /(どう|なぜ|理由|すべき|したほう|いいの)/u.test(t)) {
    return '受け取った。\n判断は上で確定する。';
  }

  // 5) 既定：存在返し（最小）
  return '受け取った。\nそのまま、ここに置ける。';
}

// ---- main

export async function runNormalBase(args: { userText: string }): Promise<NormalBaseResult> {
  const userText = String(args.userText ?? '').trim();

  // 非常用：空でも “……” は返さない
  if (!userText) {
    return {
      text: '受け取った。',
      meta: { source: 'normal_base' },
    };
  }

  const raw = pickEmergencyLine(userText);
  const text = normalizeOutput(raw);

  const finalText =
    text.trim().length > 0 ? text : '受け取った。\n言葉は、ここにある。';

  return {
    text: finalText,
    meta: { source: 'normal_base' },
  };
}
