// src/lib/iros/protocols/perspectiveShift.ts
// 「北極星（アンカー）」や「ヒント」を出すブロック生成
// 方針：アンカーは “確定（set/reset）している時だけ” 北極星として出す。
//      未確定（none/confirm）のときは、Insight ヒントを1つだけ出す。

type Maybe<T> = T | null | undefined;

export type AnchorEventType = 'none' | 'confirm' | 'set' | 'reset';

/**
 * ここでは IrosMeta の完全型に依存しないため、必要最低限だけ参照する。
 * system.ts 側の meta から下のキーが来ていれば動く。
 */
export type PerspectiveShiftMeta = {
  qCode?: Maybe<'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5'>;
  depth?: Maybe<string>;
  phase?: Maybe<'Inner' | 'Outer'>;
  situationSummary?: Maybe<string>;
  recentTopic?: Maybe<string>;
  userText?: Maybe<string>;

  // ✅ 重要：このターンのアンカー確定イベント
  // - set/reset のときだけ北極星として表示する
  anchorEventType?: Maybe<AnchorEventType>;

  // 互換：どこかに入ってる可能性があるイベント名
  intentAnchorEventType?: Maybe<AnchorEventType>;
  anchorEvent?: Maybe<{ type?: Maybe<AnchorEventType> }>;

  // アンカー（北極星）候補：どの形でも拾えるようにしておく
  // ※ unified.intent_anchor / intent_anchor の形も拾う
  intentAnchor?: Maybe<{
    anchor_text?: Maybe<string>;
    anchorText?: Maybe<string>;
    text?: Maybe<string>;
  }>;
  intent_anchor?: Maybe<{
    text?: Maybe<string>;
    anchor_text?: Maybe<string>;
  }>;
  unified?: Maybe<{
    intent_anchor?: Maybe<{
      text?: Maybe<string>;
      anchor_text?: Maybe<string>;
    }>;
  }>;
};

function normalizeText(t: Maybe<string>): string {
  return (t ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

/** 互換込みで anchorEventType を拾う（最終的に set/reset だけが“北極星”） */
function pickAnchorEventType(meta: PerspectiveShiftMeta): AnchorEventType {
  const t1 = meta.anchorEventType;
  if (t1 === 'none' || t1 === 'confirm' || t1 === 'set' || t1 === 'reset') return t1;

  const t2 = meta.intentAnchorEventType;
  if (t2 === 'none' || t2 === 'confirm' || t2 === 'set' || t2 === 'reset') return t2;

  const t3 = meta.anchorEvent?.type;
  if (t3 === 'none' || t3 === 'confirm' || t3 === 'set' || t3 === 'reset') return t3;

  return 'none';
}

function pickAnchorText(meta: PerspectiveShiftMeta): string {
  const a = meta.intentAnchor;
  const u1 = meta.unified?.intent_anchor;
  const u2 = meta.intent_anchor;

  const t =
    normalizeText(a?.anchor_text) ||
    normalizeText(a?.anchorText) ||
    normalizeText(a?.text) ||
    normalizeText(u1?.text) ||
    normalizeText(u1?.anchor_text) ||
    normalizeText(u2?.text) ||
    normalizeText(u2?.anchor_text);

  return t;
}

/**
 * Qコードごとに「洞察のネタ（Insight）」を1つだけ返す。
 * ※ここは後で世界観に寄せて増やせる。
 */
function buildInsightHint(meta: PerspectiveShiftMeta): string {
  const q = meta.qCode ?? null;

  const s = normalizeText(meta.situationSummary);
  const u = normalizeText(meta.userText);
  const hasMaterial = Boolean(s || u);

  const byQ: Record<NonNullable<PerspectiveShiftMeta['qCode']>, string> = {
    Q1: 'いまは「秩序を保ちたい／崩したくない」が強く働いているかもしれません。',
    Q2: 'いまは「動くと確定してしまう」ことへの警戒が混ざっているかもしれません。',
    Q3: 'いまは「不確実さの中で安全を確保したい」が前に出ているかもしれません。',
    Q4: 'いまは「踏み込むのが怖い／侵入されたくない」の境界反応が出ているかもしれません。',
    Q5: 'いまは「空っぽに感じるほど消耗している」か「火を戻したい」が同時に来ているかもしれません。',
  };

  const base = q
    ? byQ[q]
    : 'いまは「状況そのもの」より「心の揺れ方」に答えが埋まっているかもしれません。';

  if (hasMaterial) {
    const tail = s ? `（状況: ${s}）` : u ? `（発話: ${u}）` : '';
    return `${base}\n${tail}`.trim();
  }

  return base;
}

/**
 * 文章ブロック生成
 * - アンカーが “確定（set/reset）” → 北極星ブロック
 * - それ以外 → Insight ヒントを1つだけ
 */
export function buildPerspectiveShiftBlock(meta: PerspectiveShiftMeta): string {
  const eventType = pickAnchorEventType(meta);
  const anchor = pickAnchorText(meta);

  // ✅ set/reset のときだけ北極星を出す（none/confirm は出さない）
  if ((eventType === 'set' || eventType === 'reset') && anchor) {
    return ['【北極星】', anchor].join('\n');
  }

  // ✅ それ以外はヒント（1つだけ）
  const hint = buildInsightHint(meta);
  if (!hint) return '';

  return ['【ヒント】', hint].join('\n');
}
