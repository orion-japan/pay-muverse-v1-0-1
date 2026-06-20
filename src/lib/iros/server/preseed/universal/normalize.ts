export function normalizeLite(v: any): string {
  return String(v ?? '')
    .trim()
    .replace(/[ \t\r\n　]/g, '')
    .toLowerCase();
}

const PERSON_SUFFIX_RE = /(さん|先生|様|くん|ちゃん|氏)$/u;

const TARGET_TRAILING_RE =
  /(の診断結果|の診断内容|の診断|の情報|のこと|の状態|の現在地|の文脈|のメモ|のプロフィール|の話|の要点|の流れ|の背景|の件|との関係|について)$/u;

const GENERIC_NON_PERSON_LABELS = new Set([
  'お子',
  'お子さん',
  '子供',
  '子ども',
  'こども',
  '息子',
  '息子さん',
  '娘',
  '娘さん',
  '長男',
  '長女',
  '次男',
  '次女',
  '家族',
  '家族構成',
  '母',
  '母親',
  '父',
  '父親',
  '兄',
  '姉',
  '弟',
  '妹',
  '夫',
  '妻',
  '旦那',
  '旦那さん',
  '奥さん',
  '彼',
  '彼女',
  '相手',
  '相談者',
  '友人',
  '恋人',
  '元恋人',
  '先生',
  'クライアント',
  'スタッフ',
  '弟子',
]);

function isGenericNonPersonLabel(v: unknown): boolean {
  const s = String(v ?? '').trim().replace(/[ \t\r\n　]/g, '');
  return GENERIC_NON_PERSON_LABELS.has(s);
}

export function normalizePersonLabel(v: any): string {
  let s = String(v ?? '')
    .trim()
    .replace(/[「」『』（）()【】\[\]]/g, '')
    .replace(/[ \t\r\n　]/g, '');

  s = s.replace(TARGET_TRAILING_RE, '');
  s = s.replace(PERSON_SUFFIX_RE, '');

  if (isGenericNonPersonLabel(s)) return '';
  return s;
}

export function normalizeTargetKey(v: any): string {
  return normalizePersonLabel(v).toLowerCase();
}

export function getTurnText(t: any): string {
  return String(
    t?.content ??
      t?.text ??
      t?.assistantText ??
      t?.message ??
      t?.body ??
      ''
  ).trim();
}

export function safeHead(v: any, len = 120): string {
  return String(v ?? '').trim().slice(0, len);
}
