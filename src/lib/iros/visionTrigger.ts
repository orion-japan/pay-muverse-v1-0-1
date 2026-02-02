// src/lib/iros/visionTrigger.ts
// Iros Vision-Trigger 検出＆meta更新ヘルパー
// - 「もっと先を見せて」「ビジョンを作りたい」などの入力から
//   ビジョンモードへの自動遷移を判定する
// - 明示トリガー（explicit）と、ふわっとしたビジョン系キーワード（implicit）を分けて扱う
// - 実際の LLM 呼び出しは generateIrosReply 側で行う前提

import type { IrosMeta, IrosMode } from '@/lib/iros/system';

export type VisionTriggerInput = {
  /** 直近ユーザーの入力テキスト */
  text: string;
  /** 現在までの meta（あれば） */
  meta?: IrosMeta | null;
};

export type VisionTriggerResult = {
  /** Vision-Trigger で更新された meta（trigger していなければそのまま） */
  meta: IrosMeta;
  /** Vision モードが発火したか */
  triggered: boolean;
  /** トリガーの種類（explicit: 明示 / implicit: 自然遷移） */
  triggerKind: 'explicit' | 'implicit' | null;
  /** 実際にヒットしたトリガー語句（デバッグ・ログ用） */
  triggerPhrases: string[];
};

/* =========================================================
   トリガー語句定義
   - explicit: ユーザーがほぼ「ビジョン見せて」と直接言っているもの
   - implicit: 未来・ビジョン・世界の先を感じさせるニュアンス
========================================================= */

/** 明示トリガー：ビジョンモードへ強制ジャンプ */
const EXPLICIT_VISION_PHRASES: string[] = [
  'もっと想像させて',
  'ビジョンを見せて',
  '先の世界を教えて',
  'なったあとの世界を見たい',
  'その先の景色を一緒に見たい',
  'ここに連れていってほしい',
  'ここに連れて行ってほしい',
  '思い出させてほしい',
  '未来のビジョンを見せて',
  '先のビジョンを見せて',
];

/** 暗黙トリガー：状況に応じてビジョン寄りにシフトさせたい語 */
const IMPLICIT_VISION_KEYWORDS: string[] = [
  'ビジョンを作りたい',
  'ビジョンをつくりたい',
  'ビジョンを描きたい',
  '未来のビジョン',
  '未来像',
  '将来像',
  '世界に羽ばたく',
  '未来の景色',
  '先の景色',
  '収入になるビジョン',
  'ビジョンを一緒に考えて',
  '未来に向かう',
];

/* =========================================================
   メイン: Vision-Trigger 検出＆meta 更新
========================================================= */

export function detectVisionTrigger(
  input: VisionTriggerInput,
): VisionTriggerResult {
  const { text, meta } = input;
  const baseMeta: IrosMeta = (meta ?? {}) as IrosMeta;

  const normalized = (text || '').trim();
  if (!normalized) {
    return {
      meta: baseMeta,
      triggered: false,
      triggerKind: null,
      triggerPhrases: [],
    };
  }

  // 日本語は大小文字の概念が薄いので、とりあえずそのまま + lower の両方を見る
  const lower = normalized.toLowerCase();

  const hitExplicit = EXPLICIT_VISION_PHRASES.filter(
    (p) => normalized.includes(p) || lower.includes(p.toLowerCase()),
  );

  const hitImplicit = IMPLICIT_VISION_KEYWORDS.filter(
    (p) => normalized.includes(p) || lower.includes(p.toLowerCase()),
  );

  // どちらもヒットしなければ何もしない
  if (hitExplicit.length === 0 && hitImplicit.length === 0) {
    return {
      meta: baseMeta,
      triggered: false,
      triggerKind: null,
      triggerPhrases: [],
    };
  }

  // 明示トリガーが 1 つでもあれば explicit 優先
  const triggered = true;
  const triggerKind: 'explicit' | 'implicit' =
    hitExplicit.length > 0 ? 'explicit' : 'implicit';
  const triggerPhrases =
    triggerKind === 'explicit' ? hitExplicit : hitImplicit;

  // 既存の mode / presentationKind を維持しつつ、ビジョン寄りに上書き
  const nextMode: IrosMode = 'vision';
  const nextMeta: IrosMeta = {
    ...baseMeta,
    mode: nextMode,
    // presentationKind は text からの「話し方の重心」ヒント
    // generateIrosReply 側で vision 用のスタイルに使う想定
    presentationKind: 'vision',
  } as IrosMeta & { presentationKind?: string };

  return {
    meta: nextMeta,
    triggered,
    triggerKind,
    triggerPhrases,
  };
}

/* =========================================================
   補助: デバッグ用ログ出力（必要ならオーケストレーターから使用）
========================================================= */

export function logVisionTrigger(result: VisionTriggerResult) {
  if (!result.triggered) return;
  try {
    console.log('[IROS][VisionTrigger] fired', {
      triggerKind: result.triggerKind,
      triggerPhrases: result.triggerPhrases,
      mode: (result.meta as any)?.mode,
      presentationKind: (result.meta as any)?.presentationKind,
    });
  } catch {
    // ログ失敗しても本体には影響させない
  }
}
