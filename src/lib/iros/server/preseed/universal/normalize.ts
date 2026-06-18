export function normalizeLite(v: any): string {
  return String(v ?? '')
    .trim()
    .replace(/[ \t\r\n　]/g, '')
    .toLowerCase();
}

export function normalizeTargetKey(v: any): string {
  return String(v ?? '')
    .trim()
    .replace(/[ \t\r\n　]/g, '')
    .replace(/さん$/u, '')
    .replace(/先生$/u, '')
    .replace(/様$/u, '')
    .toLowerCase();
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
