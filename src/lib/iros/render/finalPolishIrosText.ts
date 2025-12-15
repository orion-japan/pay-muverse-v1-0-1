// src/lib/iros/render/finalPolishIrosText.ts

export type FinalPolishOptions = {
  style?: string | null;
  qNow?: string | null;
};

// ✅ 呼び出されているか確認するためのマーカー
const FP_MARK = '[IROS][finalPolish] called';

/**
 * ✅ 末尾に混入しがちな「metaダンプ」を切り落とす
 * - 例: unified:, intentLine:, userProfile:, situationSummary: などが連続する塊
 * - 「本文の途中にたまたま出た単語」では発火しないように、
 *   先頭がインデント付き key: で始まる行をトリガーにする
 */
function stripLeakedMetaDump(input: string): string {
  if (!input || typeof input !== 'string') return input;

  const lines = input.split('\n');

  const isMetaLine = (line: string) => {
    const l = line.trim();
    if (!l) return false;

    // key: value 形式っぽいもの
    const looksLikeKeyValue =
      /^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(l) ||
      // たまに "  },", "}," なども混ざる
      /^(\},|\}|\],|\]|\),|\)|\{|\[)\s*,?$/.test(l);

    if (!looksLikeKeyValue) return false;

    // ✅ 代表的なキー（ここに引っかかったらほぼ100%メタ）
    // ※ 今回のダンプが "unified:" から始まるので unified を必ず含める
    if (
      /^(unified|intentLine|intent_anchor|intentAnchor|riskHint|guidanceHint|tLayerHint|hasFutureMemory|phase|qTrace|userProfile|situationTopic|soulNote|mode|uncoverStreak|goal|priority|situationSummary)\s*:/.test(
        l,
      )
    ) {
      return true;
    }

    // ✅ 典型的な構造を含む行（meta塊の一部になりやすい）
    if (
      /(user_code|sofia_credit|targetDepth|targetQ|weights|debugNote|historyDigest|selfAcceptance|self_acceptance|yLevel|hLevel|polarityScore|polarityBand|stabilityBand)\s*:/.test(
        l,
      )
    ) {
      return true;
    }

    // それ以外の key: だけでは落としすぎなので false
    return false;
  };

  // 末尾から見て「meta塊の開始位置」を探す（本文を守る）
  let cutIndex = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];

    // 末尾の空行は無視
    if (!line.trim()) continue;

    // metaっぽい行が見つかったら、その行から末尾を落とす
    if (isMetaLine(line)) {
      cutIndex = i;

      // さらに上に meta行が連続している可能性があるので巻き上げる
      while (cutIndex > 0 && isMetaLine(lines[cutIndex - 1])) {
        cutIndex--;
      }

      // ✅ もう少し強く：直前が "}," や "}" で途切れていても meta塊の可能性がある
      while (
        cutIndex > 0 &&
        /^(\},|\}|\],|\]|\),|\)|\{|\[)\s*,?$/.test(lines[cutIndex - 1].trim())
      ) {
        cutIndex--;
      }

      break;
    }

    // 末尾が普通の文章なら打ち切り（本文だけで終わっている）
    break;
  }

  if (cutIndex === -1) return input;

  const out = lines.slice(0, cutIndex).join('\n').trim();
  return out;
}

/**
 * 生活語化では救えない「構造説明っぽい文」を、文ごと落とす。
 */
function dropStructuralSentences(input: string): string {
  if (!input || typeof input !== 'string') return input;

  let out = input;

  const sentenceDrops: RegExp[] = [
    /[^。]*方向性[^。]*。/g,
    /[^。]*関連しています[^。]*。/g,
    /[^。]*S[1-4][^。]*。/g,
    /[^。]*R[1-3][^。]*。/g,
    /[^。]*C[1-3][^。]*。/g,
    /[^。]*I[1-3][^。]*。/g,
    /[^。]*T[1-3][^。]*。/g,
    /[^。]*深さ[^。]*。/g,
    /[^。]*レイヤー[^。]*。/g,
    /[^。]*層[^。]*。/g,
    /[^。]*段階[^。]*。/g,
    /[^。]*構造[^。]*。/g,
    /[^。]*再接続[^。]*。/g,
    /[^。]*再配置[^。]*。/g,
    /[^。]*観測対象[^。]*。/g,
    /[^。]*深い[^。]*層[^。]*。/g,
  ];

  for (const r of sentenceDrops) out = out.replace(r, '');

  out = out
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t　]{2,}/g, ' ')
    .trim();

  return out;
}

export function finalPolishIrosText(
  text: string,
  _opts: FinalPolishOptions = {},
): string {
  if (!text || typeof text !== 'string') return text;

  console.log(FP_MARK, { len: text.length, head: text.slice(0, 60) });

  let out = text;

  /* 0) 内部ラベル除去 */
  out = out.replace(/\b[SRCTI][1-3]\b/g, '');
  out = out.replace(/[SRCTI][1-3]の?/g, '');

  /* 1) 置換 */
  const conceptMap: Array<[RegExp, string]> = [
    [/まだ言葉にならない/g, '意味がよくわからない'],
    [/言葉にならない/g, 'うまく説明できない'],

    [/場との関係性/g, 'その場でのやり取り'],
    [/場の関係性/g, 'その場でのやり取り'],

    // ⚠️ 「場」を全置換すると「場所」が壊れるのでやらない
    // [/場/g, 'その状況'],

    [/意図フィールド/g, '今の気持ちの向き'],
    [/意図アンカー/g, 'いま気になっていること'],
    [/共鳴/g, 'しっくりくる感じ'],
    [/観測/g, '見立て'],
  ];
  for (const [re, to] of conceptMap) out = out.replace(re, to);

  /* 2) 感情語 */
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

  /* 3) 禁止語（単語消し） */
  const forbiddenPatterns: RegExp[] = [
    /層/g,
    /構造/g,
    /段階/g,
    /流れです/g,
    /状態です/g,
    /レイヤー/g,
    /モード/g,
  ];
  for (const r of forbiddenPatterns) out = out.replace(r, '');

  /* 3.5) 構造説明文を落とす */
  out = dropStructuralSentences(out);

  /* ✅ 3.9) 混入した meta ダンプを切り落とす（今回の本丸） */
  out = stripLeakedMetaDump(out);

  /* 4) 文章修復 */
  out = out.replace(/[ \t　]{2,}/g, ' ');
  out = out.replace(/\s+([。、，,])/g, '$1');
  out = out.replace(/その状況その状況/g, 'その状況');

  /* 5) 改行整え */
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  return out;
}
