// src/lib/iros/render/finalPolishIrosText.ts

export type FinalPolishOptions = {
  style?: string | null;
  qNow?: string | null;

  /**
   * ✅ renderEngine から渡せる場合だけ使う（互換性のため optional）
   * - ここが渡ると「足踏みループを増幅させる後処理」を抑制できる
   */
  noQuestion?: boolean;
  spinLoop?: string | null;
  spinStep?: number | null;
  userWantsEssence?: boolean | null;
};

const FP_MARK = '[IROS][finalPolish] called';

/* =========================================================
   utilities
   ========================================================= */

function safeDebugLog(...args: any[]) {
  // 本番ログを汚さない
  if (process.env.NODE_ENV === 'production') return;
  console.log(...args);
}

/**
 * ✅ 末尾に混入しがちな「metaダンプ」を切り落とす
 * - "unified:" などの key: 行が連続する塊を末尾から検出して落とす
 * - 本文中の普通の文章の「〜:」で誤爆しないように条件を厳しめにする
 */
function stripLeakedMetaDump(input: string): string {
  if (!input || typeof input !== 'string') return input;

  const lines = input.split('\n');

  const isBracketOnly = (l: string) =>
    /^(\},|\}|\],|\]|\),|\)|\{|\[)\s*,?$/.test(l);

  const isMetaKeyLine = (line: string) => {
    const l = line.trim();
    if (!l) return false;

    // 「key:」っぽい（JSON/YAML風）
    const looksLikeKeyValue = /^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(l);
    if (!looksLikeKeyValue && !isBracketOnly(l)) return false;

    // 代表的なキー（ここが出たらほぼメタ）
    if (
      /^(unified|intentLine|intent_anchor|intentAnchor|riskHint|guidanceHint|tLayerHint|hasFutureMemory|phase|qTrace|userProfile|situationTopic|soulNote|mode|uncoverStreak|goal|priority|situationSummary|extra|vector|label)\s*:/.test(
        l,
      )
    ) {
      return true;
    }

    // 典型的な内部キー
    if (
      /(user_code|sofia_credit|targetDepth|targetQ|weights|debugNote|historyDigest|selfAcceptance|self_acceptance|yLevel|hLevel|polarityScore|polarityBand|stabilityBand|intent_anchor|depthStage|qPrimary)\s*:/.test(
        l,
      )
    ) {
      return true;
    }

    // それ以外の "key:" だけでは落としすぎになるので false
    return false;
  };

  // 末尾から「メタ塊の開始位置」を探す（本文を守る）
  let cutIndex = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    const l = raw.trim();

    // 末尾の空行はスキップ
    if (!l) continue;

    // metaっぽい行が見つかったら、その行から末尾を落とす
    if (isMetaKeyLine(raw)) {
      cutIndex = i;

      // 上に meta行が連続している可能性があるので巻き上げる
      while (cutIndex > 0 && isMetaKeyLine(lines[cutIndex - 1])) cutIndex--;

      // さらに手前に "}" などが連続していたら一緒に落とす
      while (cutIndex > 0 && isBracketOnly(lines[cutIndex - 1].trim()))
        cutIndex--;

      break;
    }

    // 末尾が普通の文章なら打ち切り（本文だけで終わっている）
    break;
  }

  if (cutIndex === -1) return input;

  return lines.slice(0, cutIndex).join('\n').trim();
}

/**
 * ✅ 生活語化では救えない「構造説明っぽい文」を、文ごと落とす。
 * - 過剰に落とすと本文が薄くなるので、ルールは “強すぎない” ように整理
 */
function dropStructuralSentences(input: string): string {
  if (!input || typeof input !== 'string') return input;

  let out = input;

  // 「説明口調」の定型を優先的に落とす
  const sentenceDrops: RegExp[] = [
    /[^。]*方向性[^。]*。/g,
    /[^。]*関連しています[^。]*。/g,
    /[^。]*観測対象[^。]*。/g,
    /[^。]*再配置[^。]*。/g,
    /[^。]*再接続[^。]*。/g,

    // S/R/C/I/T の “ラベル説明” が文章になって出た場合だけ落とす（単体削除より安全）
    /[^。]*\b[SRCTI][1-3]\b[^。]*。/g,
    /[^。]*(レイヤー|層|段階|構造)[^。]*。/g,
  ];

  for (const r of sentenceDrops) out = out.replace(r, '');

  // 空白・改行を整える
  out = out
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t　]{2,}/g, ' ')
    .trim();

  return out;
}

/**
 * ✅ “足踏みループ” を生む後処理を抑制する判定
 * - spin が最後段（仮に 2）に来ている/問いなし/エッセンス希望 のときは
 *   余計な「整え」や「安全な付け足し」が悪化しやすいので触らない
 */
function shouldBypassPolish(opts: FinalPolishOptions): boolean {
  const spinStep =
    typeof opts.spinStep === 'number' ? opts.spinStep : undefined;

  // エッセンス優先 or 回転が終端に近い / 問い無し → 触らない
  if (opts.userWantsEssence) return true;
  if (opts.noQuestion && spinStep != null && spinStep >= 2) return true;

  // spinLoop が明示され、終端に近いなら触らない（互換: spinStep 未指定でも loop だけで軽く判定）
  if (opts.spinLoop && spinStep != null && spinStep >= 2) return true;

  return false;
}

/* =========================================================
   main
   ========================================================= */

export function finalPolishIrosText(
  text: string,
  opts: FinalPolishOptions = {},
): string {
  if (!text || typeof text !== 'string') return text;

  safeDebugLog(FP_MARK, { len: text.length, head: text.slice(0, 60), opts });

  // 先に “末尾メタダンプ” を落とす（これが混じると後工程が誤爆する）
  let out = stripLeakedMetaDump(text);

  // ✅ ここで「触らない」判定（足踏みループを悪化させない）
  if (shouldBypassPolish(opts)) {
    // ただし最低限の “壊れ” だけ直す
    out = out
      .replace(/[ \t　]{2,}/g, ' ')
      .replace(/\s+([。、，,])/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return out;
  }

  /* 0) 内部ラベルの“単体”除去（説明文は dropStructuralSentences が担当） */
  out = out.replace(/\b[SRCTI][1-3]\b/g, '');
  out = out.replace(/[SRCTI][1-3]の?/g, '');

  /* 1) 概念置換（言い換えは最小・安全） */
  const conceptMap: Array<[RegExp, string]> = [
    [/まだ言葉にならない/g, '意味がよくわからない'],
    [/言葉にならない/g, 'うまく説明できない'],

    [/場との関係性/g, 'その場でのやり取り'],
    [/場の関係性/g, 'その場でのやり取り'],

    // ⚠️ 「場」全置換は「場所」を壊すので禁止

    [/意図フィールド/g, '今の気持ちの向き'],
    [/意図アンカー/g, 'いま気になっていること'],
    [/共鳴/g, 'しっくりくる感じ'],
    [/観測/g, '見立て'],
  ];
  for (const [re, to] of conceptMap) out = out.replace(re, to);

  /* 2) 感情語（柔らかく） */
  const emotionMap: Array<[RegExp, string]> = [
    [/怒り/g, 'イライラ'],
    [/不安/g, '心配'],
    [/恐怖/g, '怖さ'],
    [/緊張/g, '気を張っている感じ'],
    [/防御/g, '身構えている感じ'],
    [/空虚/g, '気持ちが空っぽな感じ'],
    [/戸惑い/g, 'うまく受け止めきれない感じ'],
    [/焦り/g, '落ち着かない感じ'],
    [/違和感/g, 'なんか引っかかる感じ'],
    [/抵抗/g, 'ちょっと引っかかる感じ'],
  ];
  for (const [re, to] of emotionMap) out = out.replace(re, to);

  /* 3) 禁止語（“単語丸ごと削除” は文章崩壊しやすいので限定的に） */
  // - 「層」「構造」などは “説明文” として出たときだけ dropStructuralSentences で落とす
  // - ここでは露骨なシステム語尾だけを削る
  const forbiddenPatterns: RegExp[] = [/流れです/g, /状態です/g];
  for (const r of forbiddenPatterns) out = out.replace(r, '');

  /* 3.5) 構造説明文を落とす（文単位） */
  out = dropStructuralSentences(out);

  /* 4) 不自然な日本語の“壊れ”修復（最低限） */
  out = out
    // 「あるです」「感じられるです」など
    .replace(/あるです/g, 'あります')
    .replace(/感じられるです/g, '感じられます')
    .replace(/増しているです/g, '増しています')
    .replace(/重く感じられるです/g, '重く感じられます')
    .replace(/かき消してしまうこともあるです/g, 'かき消してしまうこともあります')
    // 「持ち。」みたいな語幹切れ（末尾）
    .replace(/持ち。\s*$/g, '持ってみてください。')
    // “置いておこう” の直前に不要な動詞があるパターンを少しだけ救う
    .replace(/(進めて|続けて)置いておこう/g, '置いておこう')
    // 記号まわり
    .replace(/[ \t　]{2,}/g, ' ')
    .replace(/\s+([。、，,])/g, '$1')
    .replace(/その状況その状況/g, 'その状況');

  /* 5) 改行整え */
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  return out;
}
