// src/lib/iros/server/handleIrosReply.micro.ts
// iros — micro gate helpers (extracted from handleIrosReply.ts)
//
// 目的：micro判定/相づちbypass判定を単独化して handleIrosReply.ts を軽量化する
// 方針：
// - 文字列抽出は stringify しない（[object Object] 混入を避ける）
// - 入力は (userText, history) のみ。外部依存を持たない

function normalizeTailPunct(s: string): string {
  return (s ?? '').trim().replace(/[！!。．…]+$/g, '').trim();
}

function buildMicroCore(raw: string) {
  const rawTrim = (raw ?? '').trim();
  const hasQuestion = /[?？]$/.test(rawTrim);

  // 末尾句読点を落として、空白と疑問符を除去した “core”
  const core = normalizeTailPunct(rawTrim)
    .replace(/[?？]/g, '')
    .replace(/\s+/g, '')
    .trim();

  return { rawTrim, hasQuestion, core, len: core.length };
}

// ✅ 相づち（micro 判定でも使う）
function isAckCore(coreRaw: string): boolean {
  const core = normalizeTailPunct(coreRaw)
    .replace(/[?？]/g, '')
    .trim()
    .toLowerCase();

  const ack = new Set([
    'はい',
    'はいはい',
    'うん',
    'うんうん',
    'そう',
    'そうだね',
    'そうですね',
    '了解',
    '了解です',
    'りょうかい',
    'なるほど',
    'たしかに',
    'よし',
    'ok',
    'okay',
    'おーけー',
    'オーケー',
  ]);

  return ack.has(core);
}

// ✅ 挨拶（micro とは別に扱いたいので export）
export function isGreetingTurn(raw: string): boolean {
  const s = (raw ?? '').trim();
  if (!s) return false;

  const core = normalizeTailPunct(s).replace(/[?？]/g, '').trim();

  // 最小セット（必要なら増やす）
  const patterns = [
    /^(おはよう|おはようございます)$/u,
    /^(こんにちは)$/u,
    /^(こんばんは|こんばんわ)$/u,
    /^(はじめまして)$/u,
    /^(よろしく|よろしくお願いします)$/u,
    /^(失礼します|失礼しました)$/u,
    /^(ありがとう|ありがとうございます)$/u,
    /^(お疲れ|おつかれ|お疲れさま|おつかれさま)$/u,
  ];

  return patterns.some((re) => re.test(core));
}

export function shouldBypassMicroGate(userText: string): boolean {
  const s = (userText ?? '').trim();
  if (!s) return false;

  const keywords = [
    '覚えて',
    '覚えてない',
    'なんでしたっけ',
    '何でしたっけ',
    'さっき',
    '先ほど',
    '前に',
    '目標',
    'どれだっけ',
    'どっちだっけ',
    '言った',
  ];

  return keywords.some((k) => s.includes(k));
}

/**
 * 相づち系（そうですね/はい/うん等）が、
 * 直前の assistant 発話（質問・続き要求）に対する返答なら micro を避ける。
 */
export function shouldBypassMicroGateByHistory(args: {
  userText: string;
  history: any[] | null | undefined;
}): boolean {
  const s = (args.userText ?? '').trim();
  if (!s) return false;

  const core = normalizeTailPunct(s).replace(/[?？]/g, '').trim();
  if (!isAckCore(core)) return false;

  const h = Array.isArray(args.history) ? args.history : [];
  if (h.length <= 0) return false;

  const pickText = (v: any): string => {
    if (typeof v === 'string') return v;
    if (v == null) return '';
    if (Array.isArray(v)) {
      return v
        .map((p) => {
          if (typeof p === 'string') return p;
          if (p?.type === 'text' && typeof p?.text === 'string') return p.text;
          if (typeof p?.text === 'string') return p.text;
          if (typeof p?.content === 'string') return p.content;
          return '';
        })
        .filter(Boolean)
        .join(' ');
    }
    if (typeof v === 'object') {
      if (typeof v.text === 'string') return v.text;
      if (typeof v.content === 'string') return v.content;
      if (typeof v.message === 'string') return v.message;
    }
    return '';
  };

  // 直前の assistant 発話を拾う（content/text/message 全対応）
  let lastA: string | null = null;
  for (let i = h.length - 1; i >= 0; i--) {
    const m = h[i];
    const role = String(m?.role ?? '').toLowerCase();
    if (role === 'assistant') {
      const t = pickText(m?.content ?? m?.text ?? m?.message ?? null).trim();
      if (t) lastA = t;
      break;
    }
  }
  if (!lastA) return false;

  // ✅「続きが来る前提」なら bypass（質問/選択/続き要求）
  if (/[?？]$/.test(lastA)) return true;
  if (/(どれ|どこ|いつ|なに|何|どう|なぜ|どうして|教えて|選んで|どっち)/.test(lastA))
    return true;
  if (/(話して|聞かせて|続けて|もう少し|そのまま|どこからでも)/.test(lastA)) return true;

  return false;
}

export function isMicroTurn(raw: string): boolean {
  const { rawTrim, core, len, hasQuestion } = buildMicroCore(raw);
  if (!rawTrim) return false;

  // 疑問で終わるのは micro にしない（通常へ）
  if (hasQuestion) return false;

  // ✅ 挨拶は micro にしない（別ハンドリングしたければ isGreetingTurn を使う）
  if (isGreetingTurn(rawTrim)) return false;

  // ✅ 相づちは micro に入れてよい（ただし history 側の bypass が効く前提）
  if (isAckCore(core)) return true;

  // ✅ 単語（1トークン）micro は「単語っぽい」ものだけに限定する
  // - 無スペースでも「文」になっている入力（助詞/数字入り）は除外
  // - 長い無スペース文の誤爆を止めるため len 上限も必須
  const isSingleToken =
    rawTrim.length > 0 && !/\s/.test(rawTrim) && /^[\p{L}\p{N}ー・]+$/u.test(rawTrim);

  const hasDigit = /[0-9０-９]/.test(rawTrim);

  // 「文」になりやすい助詞/接続（最小セット）
  // NOTE: 「はい」は上で例外許可しているのでここで弾かれてOK
  const hasSentenceParticle = /[がをにへでとものは]|から|まで|より|ので|のに/.test(rawTrim);

  if (isSingleToken && len >= 2 && len <= 10 && !hasDigit && !hasSentenceParticle) {
    return true;
  }

  // 英数混じりは micro にしない（誤爆防止）
  if (/[A-Za-z0-9]/.test(core)) return false;

  // 疑問語は micro では扱わない（通常フローへ）
  if (/(何|なに|どこ|いつ|だれ|誰|なぜ|どうして|どうやって|いくら|何色|色)/.test(core)) {
    return false;
  }

  // 長すぎ/短すぎは micro では扱わない
  if (len < 2 || len > 10) return false;

  // 既存：短い「動詞系 micro」
  return /^(どうする|やる|やっちゃう|いく|いける|どうしよ|どうしよう|行く|行ける)$/.test(core);
}
