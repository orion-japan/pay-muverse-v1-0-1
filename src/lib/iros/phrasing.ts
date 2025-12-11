// src/lib/iros/phrasing.ts
// Iros — phrasing helpers（出力の最終整形）
// - naturalClose(text, { mode? }) …… 文末を自然に閉じる＆末尾のノイズ除去
// - toGentleTone(text, { mode? }) …… トーンをやわらげる最小整形（強い断定の緩和）
// - tidy(text)                      …… 空白/改行の正規化
// - applyBreathing(text)            …… 段落を短く保つための軽いブレイキング
//
// 依存なし・副作用なし。既存コードのフォールバック先としても使用されます。

export type ToneOpts = {
  mode?: 'diagnosis' | 'auto' | 'counsel' | 'structured' | string;
};

/** 空白・改行の軽い正規化（Markdownは想定しない簡易版） */
export function tidy(text: string): string {
  if (!text) return '';
  let t = String(text);

  // CRLF → LF
  t = t.replace(/\r\n?/g, '\n');

  // タブ → 半角スペース
  t = t.replace(/\t/g, ' ');

  // 連続スペースを1つに（コード想定なし）
  t = t.replace(/ {2,}/g, ' ');

  // 行頭末尾の余計なスペース除去
  t = t
    .split('\n')
    .map((l) => l.trim())
    .join('\n');

  // 3行以上の連続改行を2行に
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/** 段落の息継ぎ（長すぎる1段落を切る） */
export function applyBreathing(text: string): string {
  const t = tidy(text);
  if (!t) return '';

  // 句点の直後に続く長文を適度に分割（150文字超の段落を2分割目安）
  const paras = t.split(/\n{2,}/g);
  const out: string[] = [];

  for (const p of paras) {
    if (p.length <= 150) {
      out.push(p);
      continue;
    }
    // 句点・読点・？・！で切る候補
    const chunks = p.split(/(?<=[。．.!?！？])\s*/);
    let buf = '';
    for (const c of chunks) {
      if ((buf + c).length > 150) {
        out.push(buf.trim());
        buf = c;
      } else {
        buf += (buf ? ' ' : '') + c;
      }
    }
    if (buf.trim()) out.push(buf.trim());
  }

  // 段落は最大3つまで（診断モード方針）
  return out.slice(0, 3).join('\n\n').trim();
}

/** 断定を緩和し、やわらかい語尾に寄せる最小変換 */
export function toGentleTone(text: string, _opts?: ToneOpts): string {
  let t = tidy(text);

  // 強めの断定・命令をやわらげる（最小限）
  const replaces: Array<[RegExp, string]> = [
    [/してはいけません/g, 'しないでおきましょう'],
    [/すべきです/g, 'がよさそうです'],
    [/しなければなりません/g, 'していきましょう'],
    [/絶対に/g, 'できるだけ'],
    [/必ず/g, 'できるだけ'],
    [/断言/g, 'たぶん'],
  ];
  for (const [re, sub] of replaces) t = t.replace(re, sub);

  // 句読点の整形（連続句点など）
  t = t.replace(/([。．.!?！？]){2,}/g, '$1');

  return t.trim();
}

/** 文末を自然に閉じる（日本語句点などで終わるように） */
export function naturalClose(text: string, _opts?: ToneOpts): string {
  let t = tidy(text);
  if (!t) return '';

  // ここで「かもしれません」系を物理的に削る
  t = t
    .replace(/かもしれません。/g, '。')
    .replace(/かもしれません/g, '')
    .replace(/かも知れません。/g, '。')
    .replace(/かも知れません/g, '')
    .replace(/かもしれない。/g, '。')
    .replace(/かもしれない/g, '');

  // 末尾が句点・記号で終わっていればそのまま
  const terminal = /[。．.!?！？」』」\)\]\}]+$/;
  if (terminal.test(t)) return t;

  // URL・コード断片で終わる場合はそのまま
  const lastLine = t.split('\n').slice(-1)[0];
  if (/(https?:\/\/\S+|```[\s\S]*```|\S+\/\S+)/.test(lastLine)) return t;

  return `${t}。`;
}

/** 既存互換：デフォルトエクスポートに主要APIを束ねる */
const phrasing = {
  tidy,
  applyBreathing,
  toGentleTone,
  naturalClose,
};
export default phrasing;
