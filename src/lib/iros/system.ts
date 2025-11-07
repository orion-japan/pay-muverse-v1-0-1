// /src/lib/iros/system.ts
// Iros：ミラーAI（内面を映す）× パートナーAI（現実の一手まで伴走）

export type Phase = 'Inner' | 'Outer';
export type Depth =
  | 'S1' | 'S2' | 'S3'
  | 'R1' | 'R2' | 'R3'
  | 'C1' | 'C2' | 'C3'
  | 'I1' | 'I2' | 'I3';

export type Mode = 'Reflect' | 'Resonate' | 'Diagnosis';

export interface BuildOptions {
  personaName?: string;        // 既定: "Iros"
  style?: 'gentle' | 'crisp';  // 既定: 'gentle'
  extra?: string;              // 追加ディレクティブ
}

/** Systemベース（見出しを出さず「間」で語る） */
const CORE_PROMPT = `
あなたは「Iros」。助言AIではなく、相手の内面を鏡のように映し、
静けさと焦点を取り戻させるパートナーです。

- 返答は「内面の観測 → そっと整える反射 → 現実の一手 → 余韻」で構成。
- 見出しや箇条書きは使わず、2〜3文で小さく改行して“呼吸”を作る。
- 時間スケジュール（◯週・◯ヶ月）は使わない。機械語・AI語は出さない。
- 断定は避け、相手の芯（何を守ろうとしているか）に寄り添う。
- 絵文字は0〜1個まで。使うなら 🪔 を優先。
- ir診断を明示された時だけ、最初に「観測対象／位相・深度／一言」を3行で置き、
  つづく本文は“内面→現実の一手”で短くまとめる（見出しは出さない）。

- 「責任」「重荷」「義務」などの語は避け、同じ波を「意図」「信頼」「流れ」として映してください。
`.trim();

/** 文体の微調整 */
function styleLine(style: 'gentle'|'crisp'): string {
  if (style === 'crisp') {
    return [
      '- 文は短め。比喩は1回まで。結論を先に置く。',
      '- 過剰な共感句は避け、要点→一手→余韻で素早く収束。'
    ].join('\n');
  }
  return [
    '- 2〜3文で改行し、静けさと余白を保つ。',
    '- 比喩は浅く、相手の言葉の温度に合わせる。'
  ].join('\n');
}

/** 公開：Systemプロンプト構築（IROS_PROMPTは存在しない） */
export function buildSystemPrompt(opts: BuildOptions = {}): string {
  const {
    personaName = 'Iros',
    style = 'gentle',
    extra = '',
  } = opts;

  return [
    `あなたは「${personaName}」。`,
    CORE_PROMPT,
    '',
    '# 文体',
    styleLine(style),
    extra ? `\n# 追加\n${extra}` : '',
  ].join('\n').trim();
}

/** ユーティリティ：安全な末尾句点（「。」で終える） */
export function ensurePeriod(s: string): string {
  return (s ?? '').replace(/[。.\s]+$/g, '') + '。';
}

/** —— talisman（🪔）は末尾1つだけ —— */
function ensureSingleTalisman(text: string): string {
  if (!text) return '';
  // 一旦全部除去 → 末尾に1つ付ける運用（重複防止）
  const stripped = text.replace(/🪔+/g, '');
  return stripped + '🪔';
}

/** —— 自然な語尾に整える（Iros終止専用・決定版） —— */
export function naturalClose(text: string): string {
  let t = (text ?? '').trim();
  if (!t) return '🪔';

  // 全角句読点・余計な空白の正規化
  t = t
    .replace(/[｡]/g, '。')
    .replace(/。{2,}/g, '。')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  // 助詞終わりや体言止めをやわらかく。疑問・依頼は除外
  const endsWithParticle = /(の|が|を|に|へ|で|と|から|まで|より|し)$/.test(t);
  const isQuestion = /[？?]$/.test(t) || /(して(ください|くれる)?)$/.test(t);
  if (endsWithParticle && !isQuestion) t += 'ね';

  // 末尾に句点がなければ付ける（疑問符・感嘆符・🪔なら付けない）
  if (!/[。!?！？🪔]$/.test(t)) t += '。';

  // 🪔は末尾に1つだけ
  return ensureSingleTalisman(t);
}
// system.ts の末尾に（任意・互換用）
export const IROS_PROMPT = buildSystemPrompt();
