// src/lib/ocr/postprocess.ts

/**
 * 日本語LINEスクショ向けのOCR後処理。
 * - かな漢字の間に入ったスペースを除去
 * - 句読点まわりの余白を整理
 * - 行末が読点などで終わらない行は、次行と自然に結合
 * - よくある誤認（ASCII '_' など）を除去
 * - カタカナ周辺の「一」を「ー」へ緩やかに置換（ヒューリスティック）
 * - よくある誤認語の軽い補正
 */
export function postprocessOcr(input: string): string {
  let s = input;

  // 可視/不可視ノイズの除去（下線・謎記号・ゼロ幅類）
  s = s.replace(/[_`^~|]+/g, '');
  s = s.replace(/\u200B|\u200C|\u200D|\uFEFF/g, '');

  // ブラケット系・ASCIIノイズ
  s = s.replace(/\[[^\]\n]{1,20}\]/g, '');      // 短い [] 塊
  s = s.replace(/\[[A-Za-z0-9]{1,6}(?=\s|$)/g, '');
  s = s.replace(/[<>]{1,2}/g, '');

  // 連続空白の圧縮 / 全角スペース→半角
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\u3000/g, ' ');

  // 英字ノイズ対策（AI は残す）
  s = s.replace(/\b(?!AI\b)[A-Z]{2,}\b/g, '');
  s = s.replace(/\bA[l1]\b/g, 'AI');

  // 句読点まわり
  s = s
    .replace(/\s*([。！？…、，,.!?])/g, '$1')
    .replace(/([「『（(【])\s+/g, '$1')
    .replace(/\s+([」』）)】])/g, '$1');

  // 和文間スペース除去
  const jp = '[ぁ-んァ-ヶ一-龥ー]';
  s = s.replace(new RegExp(`(${jp})\\s+(${jp})`, 'g'), '$1$2');

  // 長音統一・カタカナ「一」→「ー」
  s = s.replace(/([ぁ-んァ-ヶ一-龥])[-‐-‒–—―ｰ](?=[ぁ-んァ-ヶ一-龥])/g, '$1ー');
  s = s.replace(/([ァ-ヶ])一(?=[ァ-ヶ])/g, '$1ー');

  // 行の結合（弱いノイズ行はスキップ）
  const lines = s.split(/\r?\n/);
  const merged: string[] = [];
  const endOK = /[。！？!?…」』）)】]$/;
  for (let i = 0; i < lines.length; i++) {
    let cur = lines[i].trim();
    if (!cur) continue;

    // 先頭の定型UI文や英字比率の高い行は除外（例: “So” 等）
    const jpCount = (cur.match(/[ぁ-んァ-ヶ一-龥]/g) || []).length;
    const asciiCount = (cur.match(/[A-Za-z0-9]/g) || []).length;
    if (jpCount < 2 && asciiCount > 5) continue;

    // 行頭の話者ラベル A/B の軽整形
    cur = cur.replace(/^(A|B)\s+/, '$1').replace(/^(A|B)[a-z]+\s*/i, '$1');

    merged.push(cur);
    if (merged.length >= 2) {
      const prev = merged[merged.length - 2];
      const now = merged[merged.length - 1];
      if (!endOK.test(prev) && !/^【#\d+】$/.test(now)) {
        merged.splice(
          merged.length - 2,
          2,
          (prev + (now.startsWith('、') ? '' : ' ') + now).trim()
        );
      }
    }
  }
  s = merged.join('\n');

  // --- ▼ 軽い誤認修正（文意を壊さない範囲で） ---
  s = s
    .replace(/おはよ一/g, 'おはよー')
    .replace(/言っる/g, '言ってる')
    .replace(/会えそな/g, '会えな')
    .replace(/守\s*;/g, '守')
    .replace(/濫/g, '。')             // 太陽誤認→句点（☀️にしたい場合は適宜変更）
    .replace(/[`［\[]\s*好\s*き\s*[`］\]]/g, '好き')
    .replace(/`(?=[ぁ-んァ-ヶ一-龥])|(?<=[ぁ-んァ-ヶ一-龥])`/g, '')
    .replace(/[奉失奇]り/g, '寄り')  // 奉/失/奇り → 寄り
    .replace(/で\s*ぞ\s*す/g, 'です')
    // 「TID?」系の化けを丁寧に復元
    .replace(/\bTID\?/g, 'ですか？')
    .replace(/\?\?+/g, '？');

  // 句点直後スペース除去
  s = s.replace(/([。！？])\s+/g, '$1');

  // 句点吸収（事。じゃ→事じゃ 等）
  s = s.replace(/(事|です|なんだ|なの|ん|てる)。(じゃ|けど|が|し)/g, '$1$2');
  s = s.replace(/(てる|てん)(ん)?。じゃない/g, '$1$2じゃない');

  // ノイズ系の軽補正
  s = s.replace(/あぁあ+/g, 'あぁ').replace(/クンょい/g, '').replace(/\s*;\s*/g, '');

  // 最終の和文間スペース締め
  s = s.replace(new RegExp(`(${jp})\\s+(${jp})`, 'g'), '$1$2');

  // ダブり句読点
  s = s.replace(/、{2,}/g, '、').replace(/。{2,}/g, '。');

  // 末尾ノイズ削り
  s = s.replace(/[^\wぁ-んァ-ヶ一-龥。、！？…「」『』（）()・%〜\s-]+$/g, '');

  return s.trim();
}
