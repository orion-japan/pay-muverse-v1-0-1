// src/lib/formatDate.ts
// すべて UTC から JST(UTC+9) に変換して返すユーティリティ

function toJstDate(input: string | number | Date): Date {
  const d = new Date(input);
  return new Date(d.getTime() + 9 * 60 * 60 * 1000); // UTC→JST
}

/** YYYY/MM/DD HH:mm */
export function formatJST(input: string | number | Date | null | undefined): string {
  if (!input) return '';
  const j = toJstDate(input);
  const yyyy = j.getFullYear();
  const mm = String(j.getMonth() + 1).padStart(2, '0');
  const dd = String(j.getDate()).padStart(2, '0');
  const hh = String(j.getHours()).padStart(2, '0');
  const mi = String(j.getMinutes()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
}

/** YYYY-MM-DD ← 修正 */
export function formatJSTDate(input: string | number | Date | null | undefined): string {
  if (!input) return '';
  const j = toJstDate(input);
  const yyyy = j.getFullYear();
  const mm = String(j.getMonth() + 1).padStart(2, '0');
  const dd = String(j.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** HH:mm */
export function formatJST_HM(input: string | number | Date | null | undefined): string {
  if (!input) return '';
  const j = toJstDate(input);
  const hh = String(j.getHours()).padStart(2, '0');
  const mi = String(j.getMinutes()).padStart(2, '0');
  return `${hh}:${mi}`;
}
