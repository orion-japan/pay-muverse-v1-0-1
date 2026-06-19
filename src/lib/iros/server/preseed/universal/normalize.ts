export function normalizeLite(v: any): string {
  return String(v ?? '')
    .trim()
    .replace(/[ \t\r\n　]/g, '')
    .toLowerCase();
}

const PERSON_SUFFIX_RE = /(さん|先生|様|くん|ちゃん|氏)$/u;

const TARGET_TRAILING_RE =
  /(の診断結果|の診断内容|の診断|の情報|のこと|の状態|の現在地|の文脈|のメモ|のプロフィール|の話|の要点|の流れ|の背景|の件|との関係|について)$/u;

const BUILTIN_PERSON_ALIAS: Record<string, string> = {
  りな: 'リナ',
  rina: 'リナ',
  リナ: 'リナ',
  リナちゃん: 'リナ',
  りなちゃん: 'リナ',

  みゆ: 'みゆ',
  miyu: 'みゆ',
  ミユ: 'みゆ',

  あさの: '浅野',
  浅野さん: '浅野',
  浅野: '浅野',

  はたけやま: '畠山',
  畠山さん: '畠山',
  畠山: '畠山',
};

export function normalizePersonLabel(v: any): string {
  let s = String(v ?? '')
    .trim()
    .replace(/[「」『』（）()【】\[\]]/g, '')
    .replace(/[ \t\r\n　]/g, '');

  s = s.replace(TARGET_TRAILING_RE, '');
  s = s.replace(PERSON_SUFFIX_RE, '');

  const aliasKey = s.toLowerCase();
  return BUILTIN_PERSON_ALIAS[s] ?? BUILTIN_PERSON_ALIAS[aliasKey] ?? s;
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


