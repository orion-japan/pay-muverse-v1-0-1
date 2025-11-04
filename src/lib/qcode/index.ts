// /src/lib/qcode/index.ts
import type { QCode } from '@/ui/iroschat/types';

/**
 * 超簡易ヒューリスティクス（暫定）
 * - 怒: Q2（木） / 怖: Q4（水） / 不安・心配: Q3（土） / 空虚: Q5（火） / ルール・秩序: Q1（金）
 */
export function inferQ(text: string): QCode {
  const t = text.toLowerCase();

  // 怒り/苛立ち
  if (/[怒イラつ|いらだ|むか|腹立|キレ]/u.test(text) || t.includes('angry')) return 'Q2';
  // 恐れ/怖さ
  if (/[怖|恐|こわ|不安すぎ]/u.test(text) || t.includes('scared')) return 'Q4';
  // 不安/落ち着かない
  if (/[不安|そわそわ|焦り|緊張|落ち着]/u.test(text) || t.includes('anxious')) return 'Q3';
  // 空虚/虚無/情熱空回り
  if (/[空虚|虚無|やる気が出ない|燃え尽き]/u.test(text) || t.includes('empty')) return 'Q5';
  // 秩序/完璧主義/我慢
  if (/[我慢|完璧|ルール|秩序]/u.test(text) || t.includes('rule')) return 'Q1';

  // 既定：安定寄り（Q3）
  return 'Q3';
}

export function mapQToColor(q: QCode): string {
  switch (q) {
    case 'Q1':
      return '#cfd8dc'; // 金：シルバー系
    case 'Q2':
      return '#7bd88f'; // 木：緑
    case 'Q3':
      return '#f5e6a8'; // 土：黄土
    case 'Q4':
      return '#88c0f0'; // 水：青
    case 'Q5':
      return '#f6a6a6'; // 火：赤寄り
    default:
      return '#a8b1ff';
  }
}
