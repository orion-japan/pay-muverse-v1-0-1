import type { ResolvedTarget } from './types';
import { normalizeTargetKey, normalizePersonLabel, getTurnText } from './normalize';

const COMMON_PERSON_SUFFIX = /(さん|先生|様|くん|ちゃん|氏)$/u;

function cleanLabel(v: string): string {
  return normalizePersonLabel(String(v ?? '').trim().replace(/[「」『』]/g, ''));
}

function isBadTargetLabel(label: string): boolean {
  return /^(この|その|あの|コード|実装|修正|ファイル|エラー|Git|Next|Supabase|Firebase|Muverse|Moodle|PowerShell|typecheck|npm)$/iu.test(
    label
  );
}

function pickExplicitPersonName(userText: string): string | null {
  const text = String(userText ?? '').trim();

  const patterns = [
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,20})(さん|先生|様|くん|ちゃん|氏)の/u,
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,20})(さん|先生|様|くん|ちゃん|氏)と/u,
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,20})(さん|先生|様|くん|ちゃん|氏)は/u,
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,20})の件/u,
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,20})の(?:情報|こと|状態|現在地|文脈|メモ|プロフィール|話|要点|流れ|背景)/u,
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,20})について/u,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (!m?.[1]) continue;

    const label = cleanLabel(m[1].replace(COMMON_PERSON_SUFFIX, ''));
    if (label && !isBadTargetLabel(label)) return label;
  }

  return null;
}

function pickReferenceFromHistory(historyForTurn: any[]): string | null {
  const tail = Array.isArray(historyForTurn) ? historyForTurn.slice(-8).reverse() : [];

  for (const t of tail) {
    const s = getTurnText(t);
    if (!s) continue;

    const m =
      s.match(/targetLabel[:：]\s*([^\s,}]+)/u) ??
      s.match(/targetKey[:：]\s*([^\s,}]+)/u) ??
      s.match(/([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,20})(さん|先生|様|くん|ちゃん|氏)/u);

    if (m?.[1]) return cleanLabel(m[1].replace(COMMON_PERSON_SUFFIX, ''));
  }

  return null;
}

export async function resolveTargetForPreSeed(args: {
  userText: string;
  historyForTurn?: any[];
  ctxPack?: any;
  supabase?: any;
  userCode?: string | null;
}): Promise<ResolvedTarget> {
  const userText = String(args.userText ?? '').trim();

  const explicit = pickExplicitPersonName(userText);

  if (explicit) {
    return {
      status: 'resolved',
      label: explicit,
      targetKey: normalizeTargetKey(explicit),
      canonicalName: explicit,
      aliases: [explicit],
      nicknameMatched: null,
      domain: 'person',
      confidence: 0.88,
      source: 'explicit_user_text',
    };
  }

  const ctxTarget =
    args.ctxPack?.resolvedTarget?.label ??
    args.ctxPack?.targetLabel ??
    args.ctxPack?.activeTarget?.label ??
    null;

  if (ctxTarget) {
    const label = cleanLabel(String(ctxTarget));
    return {
      status: 'resolved',
      label,
      targetKey: normalizeTargetKey(label),
      canonicalName: label,
      aliases: [label],
      nicknameMatched: null,
      domain: 'person',
      confidence: 0.72,
      source: 'active_thread',
    };
  }

  const hist = pickReferenceFromHistory(args.historyForTurn ?? []);

  if (hist && /(相手|あの人|彼|彼女|その人|この人)/u.test(userText)) {
    return {
      status: 'resolved',
      label: hist,
      targetKey: normalizeTargetKey(hist),
      canonicalName: hist,
      aliases: [hist],
      nicknameMatched: null,
      domain: 'person',
      confidence: 0.58,
      source: 'history',
    };
  }

  return {
    status: 'not_found',
    label: null,
    targetKey: null,
    canonicalName: null,
    aliases: [],
    nicknameMatched: null,
    domain: 'unknown',
    confidence: 0,
    source: 'none',
  };
}
