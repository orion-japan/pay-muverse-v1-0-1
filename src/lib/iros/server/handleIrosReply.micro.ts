// src/lib/iros/server/handleIrosReply.micro.ts
// iros — micro gate helpers (revised)
// 目的：
// - micro誤爆を減らす
// - 判定理由を可視化できる構造にする
// - history拾い漏れを減らす

import { isShortFixedPhrase } from '../language/shortFixedPhrase';

function normalizeTailPunct(s: string): string {
  return (s ?? '')
    .trim()
    .replace(/[！!。．…〜～]+$/g, '')
    .trim();
}

function buildMicroCore(raw: string) {
  const rawTrim = (raw ?? '').trim();

  const tailNormalized = normalizeTailPunct(rawTrim);
  const hasQuestion = /[?？]$/.test(tailNormalized);

  const core = tailNormalized
    .replace(/[?？]/g, '')
    .replace(/\s+/g, '')
    .trim();

  return { rawTrim, core, len: core.length, hasQuestion };
}

// --------------------------------------------------
// 相づち
// --------------------------------------------------
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

// --------------------------------------------------
// 短い定型語
// --------------------------------------------------
function isShortGreetingLike(core: string): boolean {
  return isShortFixedPhrase(core);
}

// --------------------------------------------------
// キーワード bypass
// --------------------------------------------------
export function shouldBypassMicroGate(userText: string): boolean {
  const s = (userText ?? '').trim();
  if (!s) return false;

  // ✅ micro に吸わせない入力（正規ルートへ落とす）
  // - 続き要求 / 進行要求 / 想起・参照要求は、seed/history/ctxPack が必要になりやすい
  const keywords = [
    // ---- 想起・参照系（既存） ----
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

    // ---- 進行要求（追加：今回の本丸）----
    '続けて',
    '続き',
    'つづき',
    'もう少し',
    'もうちょっと',
    'そのまま',
    '進めて',
    '進もう',
    '先へ',
    '次',
  ];

  return keywords.some((k) => s.includes(k));
}

// --------------------------------------------------
// history bypass（拾い漏れ改善版）
// --------------------------------------------------
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
    if (!v) return '';

    if (Array.isArray(v)) {
      return v
        .map((p) => {
          if (typeof p === 'string') return p;
          if (typeof p?.text === 'string') return p.text;
          if (typeof p?.content === 'string') return p.content;
          if (typeof p?.message === 'string') return p.message;
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

  let lastA: string | null = null;
  for (let i = h.length - 1; i >= 0; i--) {
    const m = h[i];
    const role = String(m?.role ?? '').toLowerCase();
    if (role === 'assistant') {
      const t = pickText(m?.content ?? m?.text ?? m?.message ?? null).trim();
      if (t) {
        lastA = t;
        break;
      }
    }
  }

  if (!lastA) return false;

  const tail = normalizeTailPunct(lastA);

  if (/[?？]$/.test(tail)) return true;
  if (/(どれ|どこ|いつ|なに|何|どう|なぜ|どうして|教えて|選んで|どっち)/.test(lastA)) {
    return true;
  }
  if (/(話して|聞かせて|続けて|もう少し|そのまま|どこからでも)/.test(lastA)) {
    return true;
  }

  return false;
}

// --------------------------------------------------
// 判定（理由付き）
// --------------------------------------------------
export function classifyMicroTurn(raw: string): {
  ok: boolean;
  reason: string;
} {
  const { rawTrim, core, len, hasQuestion } = buildMicroCore(raw);

  if (!rawTrim) return { ok: false, reason: 'EMPTY' };
  if (hasQuestion) return { ok: false, reason: 'QUESTION' };
  if (isShortGreetingLike(rawTrim)) return { ok: false, reason: 'GREETING' };
  if (isAckCore(core)) return { ok: true, reason: 'ACK' };

  const isSingleToken =
    rawTrim.length > 0 &&
    !/\s/.test(rawTrim) &&
    /^[\p{L}\p{N}ー・]+$/u.test(rawTrim);

  const hasDigit = /[0-9０-９]/.test(rawTrim);

  // 助詞の単文字弾きは削除（誤爆防止）
  const hasSentenceParticle = /(から|まで|より|ので|のに)/.test(rawTrim);

  if (isSingleToken && len >= 2 && len <= 10 && !hasDigit && !hasSentenceParticle) {
    return { ok: true, reason: 'SINGLE_TOKEN' };
  }

  if (/[A-Za-z0-9]/.test(core)) return { ok: false, reason: 'ALNUM_MIX' };

  if (/(何|なに|どこ|いつ|だれ|誰|なぜ|どうして|どうやって|いくら|何色|色)/.test(core)) {
    return { ok: false, reason: 'QUESTION_WORD' };
  }

  if (len < 2 || len > 10) return { ok: false, reason: 'LEN_OUT' };

  if (/^(どうする|やる|やっちゃう|いく|いける|どうしよ|どうしよう|行く|行ける)$/.test(core)) {
    return { ok: true, reason: 'SHORT_VERB' };
  }

  return { ok: false, reason: 'NO_MATCH' };
}

// 既存互換
export function isMicroTurn(raw: string): boolean {
  return classifyMicroTurn(raw).ok;
}
