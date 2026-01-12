// src/lib/iros/conversation/branchPolicy.ts
// iros — Branch Policy (phase11)

import type { ConvSignals } from './signals';
import type { ConvContextPack } from './contextPack';

export type ConvBranch =
  | 'REPAIR'
  | 'DETAIL'
  | 'STABILIZE'
  | 'OPTIONS'
  | 'C_BRIDGE'
  | 'I_BRIDGE'
  | 'UNKNOWN';

function norm(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim();
}

// “今”の入力が相談かどうか（広めに拾う）
function looksLikeSelfConsult(t: string): boolean {
  if (!t) return false;
  return (
    t.includes('悩') ||
    t.includes('迷') ||
    t.includes('不安') ||
    t.includes('怖') ||
    t.includes('しんど') ||
    t.includes('つら') ||
    t.includes('疲れ') ||
    t.includes('どう') ||
    t.includes('やめ') ||
    t.includes('続け')
  );
}

// ✅ ctx が“濃い”か（短文でも、直前の流れが復元できている状態）
function hasRichContext(ctx: ConvContextPack | null, now: string): boolean {
  if (!ctx?.shortSummary) return false;
  const s = norm(ctx.shortSummary);
  const t = norm(now);

  // shortSummary が今入力と同一（= 上書きされた）なら意味が薄い
  if (s && t && s === t) return false;

  // 直近ユーザー発話を束ねているなら "/" が入りやすい（あなたのcontextPack設計）
  if (s.includes(' / ')) return true;

  // それ以外でも、一定以上の長さがあれば “流れ” は復元できる
  return s.length >= 18;
}

export function decideConversationBranch(args: {
  userText: string;
  signals: ConvSignals | null;
  ctx: ConvContextPack | null;

  depthStage?: string | null; // e.g. 'R3'
  phase?: string | null; // e.g. 'Outer'
}): ConvBranch {
  const t = norm(args.userText);
  const s = args.signals;
  const ctx = args.ctx;
  const depth = norm(args.depthStage);
  const phase = norm(args.phase);

  // 1) 取りこぼし指摘は最優先
  if (s?.repair) return 'REPAIR';

  const rich = hasRichContext(ctx, t);

  // 2) 相談っぽい + R層で停滞 → Cへ橋（“整理の提案”）
  //    ※短文でも、richなら DETAIL に落とさずこちらへ進められる
  if (looksLikeSelfConsult(t) && depth.startsWith('R')) return 'C_BRIDGE';

  // 3) 情報不足（短文ラベル）でも、ctx が濃ければ DETAIL を抑止して STABILIZEへ
  if (s?.detail) {
    return rich ? 'STABILIZE' : 'DETAIL';
  }

  // 4) 進まない感が強いなら STABILIZE（落ち着かせる/整理）
  if (s?.stuck) return 'STABILIZE';

  // 5) I層は “未来の方向” だが押し付けないので条件重め
  const declaration =
    t.includes('決めた') ||
    t.includes('これでいく') ||
    t.includes('コミット') ||
    t.includes('宣言');

  if (declaration && (depth.startsWith('C') || depth.startsWith('R')) && phase) return 'I_BRIDGE';

  return 'UNKNOWN';
}
