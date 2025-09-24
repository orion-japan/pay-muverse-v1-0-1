// src/lib/formatDate.ts
/** YYYY/MM/DD HH:mm */
export function formatJST(input: string | number | Date | null | undefined): string {
  if (!input) return '';
  const date = new Date(input);
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** YYYY-MM-DD */
export function formatJSTDate(input: string | number | Date | null | undefined): string {
  if (!input) return '';
  const date = new Date(input);
  const s = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date); // "2025/09/24"
  const [yyyy, mm, dd] = s.split('/');
  return `${yyyy}-${mm}-${dd}`;
}

/** HH:mm */
export function formatJST_HM(input: string | number | Date | null | undefined): string {
  if (!input) return '';
  const date = new Date(input);
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
