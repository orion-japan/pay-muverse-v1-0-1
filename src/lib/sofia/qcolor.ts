// src/lib/sofia/qcolor.ts

export type QColor = {
  base: 'Blue' | 'Red' | 'Black' | 'Green' | 'Yellow';
  mix?: 'Purple' | 'Orange' | 'Brown' | 'White' | 'Silver';
  hex: string;
};

/**
 * Qコード → 色エネルギー（五行語を使わない）
 */
export function mapQToColor(q?: string): QColor | null {
  switch ((q || '').toUpperCase()) {
    case 'Q1':
      // 秩序・制御
      return { base: 'Black', mix: 'Silver', hex: '#2F2F33' };
    case 'Q2':
      // 成長・拡張
      return { base: 'Green', hex: '#22A559' };
    case 'Q3':
      // 安定・揺らぎ
      return { base: 'Yellow', mix: 'Brown', hex: '#D4A017' };
    case 'Q4':
      // 深さ・浄化
      return { base: 'Blue', hex: '#2563EB' };
    case 'Q5':
      // 情熱・推進
      return { base: 'Red', hex: '#E11D48' };
    default:
      return null;
  }
}
