// src/lib/mu/trace.ts
import { MU_CONFIG, MU_LOGGING } from './config';

export type MuLogDetail = 'off' | 'lite';
export type MuTraceStep = 'detect_mode' | 'state_infer' | 'indicators' | 'retrieve' | 'openai_reply';
export type MuTraceEntry = { step: MuTraceStep; data: Record<string, any> };
export type MuDialogueTraceLite = MuTraceEntry[];

/** 既定のログ詳細を安全に取得（env → MU_LOGGING → MU_CONFIG.logging の順） */
function getDefaultDetail(): MuLogDetail {
  const v1 = (MU_LOGGING as any)?.logDetail as MuLogDetail | undefined;
  if (v1 === 'off' || v1 === 'lite') return v1;
  const v2 = (MU_CONFIG as any)?.logging?.logDetail as MuLogDetail | undefined;
  if (v2 === 'off' || v2 === 'lite') return v2;
  return 'lite';
}
const DEFAULT_DETAIL: MuLogDetail = getDefaultDetail();

export class MuTrace {
  private detail: MuLogDetail;
  private trace: MuDialogueTraceLite = [];

  constructor(detail: MuLogDetail = DEFAULT_DETAIL) {
    this.detail = detail;
  }

  add(step: MuTraceStep, data: Record<string, any>) {
    if (this.detail === 'off') return;
    this.trace.push({ step, data: sanitize(data) });
  }

  dump(): MuDialogueTraceLite | undefined {
    return this.detail === 'off' ? undefined : this.trace;
  }
}

/** ---- PII を含まない派生情報だけを残すサニタイズ ---- */
function sanitize(data: Record<string, any>) {
  const copy: Record<string, any> = { ...data };

  // 原文は保持しない：長文はハッシュ化に置換
  if (typeof copy.prompt === 'string') {
    copy.prompt_hash = hash(copy.prompt);
    delete copy.prompt;
  }
  if (typeof copy.retrievedText === 'string') {
    copy.retrieve_hash = hash(copy.retrievedText);
    delete copy.retrievedText;
  }

  // signals.keywords は上位3語に圧縮（文字列化・小文字化）
  const sig = copy.signals as unknown;
  if (sig && typeof sig === 'object') {
    const s = sig as { keywords?: unknown };
    if (Array.isArray(s.keywords)) {
      (s as any).keywords = s.keywords.slice(0, 3).map(k => String(k).toLowerCase());
    }
    copy.signals = s as any;
  }

  return copy;
}

/** 軽量ハッシュ（FNV-1a 32bit） */
function hash(s: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv1a32_${h.toString(16)}`;
}
