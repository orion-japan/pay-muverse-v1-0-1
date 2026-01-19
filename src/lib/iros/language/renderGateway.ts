// src/lib/iros/language/renderGateway.ts
import { renderV2, type RenderBlock } from './renderV2';
import { logConvEvidence } from '../conversation/evidenceLog';

// ✅ Phase11 marker（「本当にこのファイルが読まれてるか」ログ証明用）
const IROS_RENDER_GATEWAY_REV = 'phase11-open-close-v2-LOADED';

// ✅ 追加：モジュールロード証明（Nextのキャッシュ/別ファイル事故を一発で潰す）
console.warn('[IROS/renderGateway][MODULE_LOADED]', {
  rev: IROS_RENDER_GATEWAY_REV,
  at: new Date().toISOString(),
});

/**
 * env flag helper
 * - true / 1 / on / yes / enabled だけを ON 扱い
 * - false / 0 / off / no / disabled / 空 は OFF 扱い
 * - 想定外の値は defaultEnabled に倒す（事故防止）
 */
function envFlagEnabled(raw: unknown, defaultEnabled = true) {
  if (raw == null) return defaultEnabled;
  const v = String(raw).trim().toLowerCase();
  if (!v) return defaultEnabled;

  if (v === '1' || v === 'true' || v === 'on' || v === 'yes' || v === 'enabled') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no' || v === 'disabled') return false;

  return defaultEnabled;
}

function head(s: string, n = 40) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function norm(s: unknown) {
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}

/** =========================================================
 * ✅ 内部ラベル除去（最終責任）
 * - system/protocol/hint 由来のタグや、メタ説明行を本文から消す
 * - “意味を壊さず短く” を優先
 * ========================================================= */
function stripInternalLabels(line: string): string {
  let s = norm(line).trim();
  if (!s) return '';

  // 0幅文字（UIで「空行に見える」やつ）を先に除去
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!s) return '';

  // 1) 角括弧ラベル（例：【WRITER_PROTOCOL】など）
  s = s.replace(/【[^】]{1,24}】/g, '').trim();

  // 2) writer hint / meta説明
  s = s.replace(/^writer hint[:：]\s*/i, '').trim();

  // 2.5) 先頭の「… / ...」はノイズ
  s = s.replace(/^(\.{3,}|…{1,})\s*/g, '').trim();
  if (s === '...' || s === '…' || /^\.{3,}$/.test(s) || /^…+$/.test(s)) return '';

  // 3) FRAME / SLOTS 系のメタ行（記号だけ/文末なしは捨てる）
  if (/^FRAME\s*=\s*.*$/i.test(s) && !/[。！？!?]/.test(s)) return '';
  if (/^SLOTS\s*=\s*.*$/i.test(s) && !/[。！？!?]/.test(s)) return '';
  s = s.replace(/^FRAME\s*=\s*\S+\s*/i, '').trim();
  s = s.replace(/^SLOTS\s*=\s*\S+\s*/i, '').trim();

  // 4) known meta labels（文末なしは捨てる）
  if (
    /^(OBS_META|ROTATION_META|IT_HINT|ANCHOR_CONFIRM|TURN_MODE|SUBMODE)\s*[:：].*$/i.test(s) &&
    !/[。！？!?]/.test(s)
  ) {
    return '';
  }
  s = s
    .replace(/^(OBS_META|ROTATION_META|IT_HINT|ANCHOR_CONFIRM|TURN_MODE|SUBMODE)\s*[:：]\s*/i, '')
    .trim();

  // 5) =/: を含む内部キーっぽい行は捨てる（本文に残す価値が薄い）
  if (
    /(phase\s*=|depth\s*=|q\s*=|spinloop\s*=|spinstep\s*=|descentgate\s*=|tLayerHint\s*=|itx_|slotPlanPolicy|slotSeed|llmRewriteSeed)/i.test(
      s,
    )
  ) {
    if (s.includes('=') || s.includes(':') || s.includes('：')) return '';
  }

  // 6) [sa ...] などのタグ単体行
  s = s.replace(/^[〔\[]sa[\w.\s-]+[〕\]]$/i, '').trim();

  // 7) 空白正規化
  s = s.replace(/\s{2,}/g, ' ').trim();

  // ✅ 句読点/記号だけの“残骸行”は捨てる（「。」だけ等）
  if (/^[\u3000\s]*[。．\.、,・:：;；!！\?？…]+[\u3000\s]*$/.test(s)) return '';

  return s;
}

function looksLikeSilence(text: string, extra: any) {
  const t = norm(text);
  if (!t) return false;

  if (
    extra?.speechAct === 'SILENCE' ||
    extra?.silencePatched === true ||
    String(extra?.silencePatchedReason ?? '').trim().length > 0 ||
    extra?.speechSkipped === true
  ) {
    return true;
  }

  if (t === '…' || t === '...' || t === '……') return true;
  if (/^…+$/.test(t)) return true;
  if (/^\.{3,}$/.test(t)) return true;

  return false;
}

function looksLikeIR(text: string, extra: any) {
  const t = norm(text);
  if (t.includes('観測対象') && t.includes('フェーズ')) return true;
  if (t.includes('位相') && t.includes('深度')) return true;

  const hint = String(extra?.requestedMode ?? extra?.modeHint ?? extra?.mode ?? '').toUpperCase();
  if (hint.includes('IR')) return true;

  return false;
}

function splitToLines(text: string): string[] {
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  if (!t) return [];

  // ✅ 余白を殺さない：行は trim しない（右端の空白だけ落とす）
  // ✅ 空行も保持する（UIで“余白”として効く）
  const rawLines = t.split('\n').map((x) => x.replace(/\s+$/g, ''));

  // 1行しかない場合だけ「読みやすく分割」するが、
  // ✅ Markdown/装飾が含まれるときは絶対に分割しない（太字/括弧/絵文字が崩れるため）
  if (rawLines.length === 1) {
    const one = rawLines[0] ?? '';
    const oneTrim = one.trim();

    const hasDecoration =
      one.includes('**') ||
      one.includes('__') ||
      one.includes('```') ||
      one.includes('[[') || // [[ILINE]] など
      one.includes(']]') ||
      /[🌀🌱🪷🪔🌸✨🔥💧🌊🌌⭐️⚡️✅❌]/.test(one); // ざっくり絵文字検知

    if (!hasDecoration) {
      const parts0 = oneTrim
        .split(/(?<=[。！？!?])/)
        .map((x) => x.trim())
        .filter(Boolean);

      // ✅ 「？（…）」みたいな注釈は同じ行に戻す
      const parts: string[] = [];
      for (const p of parts0) {
        if (parts.length > 0 && /^[（(［\[]/.test(p)) {
          parts[parts.length - 1] = `${parts[parts.length - 1]}${p}`;
        } else {
          parts.push(p);
        }
      }

      if (parts.length >= 2) return parts;

      if (oneTrim.length >= 26 && oneTrim.includes('、')) {
        const i = oneTrim.indexOf('、');
        const a = oneTrim.slice(0, i + 1).trim();
        const b = oneTrim.slice(i + 1).trim();
        return [a, b].filter(Boolean);
      }

      if (oneTrim.length >= 34) {
        const mid = Math.min(22, Math.floor(oneTrim.length / 2));
        const a = oneTrim.slice(0, mid).trim();
        const b = oneTrim.slice(mid).trim();
        return [a, b].filter(Boolean);
      }
    }

    // 装飾あり/分割不要 → そのまま返す（空行保持の方針に合わせて）
    return [one];
  }

  return rawLines;
}


type SlotExtracted = { blocks: RenderBlock[]; source: string; keys: string[] } | null;

function extractSlotBlocks(extra: any): SlotExtracted {
  const framePlan =
    extra?.framePlan ??
    extra?.meta?.framePlan ??
    extra?.extra?.framePlan ??
    extra?.orch?.framePlan ??
    null;

  const slotsRaw =
    framePlan?.slots ??
    framePlan?.slotPlan?.slots ??
    extra?.slotPlan?.slots ??
    extra?.meta?.slotPlan?.slots ??
    null;

  if (!slotsRaw) return null;

  const out: Array<{ key: string; text: string }> = [];

  if (Array.isArray(slotsRaw)) {
    for (const s of slotsRaw) {
      const key = String(s?.key ?? s?.id ?? s?.slotId ?? s?.name ?? '').trim();
      const text = norm(s?.text ?? s?.value ?? s?.content ?? s?.message ?? s?.out ?? '');
      if (!text) continue;
      out.push({ key, text });
    }
  } else if (typeof slotsRaw === 'object') {
    const ORDER = [
      'OBS',
      'SHIFT',
      'NEXT',
      'SAFE',
      'INSIGHT',
      'opener',
      'facts',
      'mirror',
      'elevate',
      'move',
      'ask',
      'core',
      'add',
    ];

    const keys = Object.keys(slotsRaw);
    keys.sort((a, b) => {
      const ia = ORDER.indexOf(a);
      const ib = ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    for (const k of keys) {
      const text = norm((slotsRaw as any)[k]);
      if (!text) continue;
      out.push({ key: String(k), text });
    }
  }

  if (out.length === 0) return null;

  const blocks: RenderBlock[] = [];
  for (const s of out) {
    const lines = splitToLines(s.text);
    for (const line of lines) {
      const cleaned = stripInternalLabels(line);
      if (cleaned) blocks.push({ text: cleaned });
    }
  }

  return {
    blocks,
    source: 'framePlan.slots',
    keys: out.map((x) => x.key),
  };
}

// ✅ evidence用：slots の key/content をそのまま抜く（UI非露出・ログ用）
function extractSlotsForEvidence(extra: any): Array<{ key: string; content: string }> | null {
  const framePlan =
    extra?.framePlan ??
    extra?.meta?.framePlan ??
    extra?.extra?.framePlan ??
    extra?.orch?.framePlan ??
    null;

  const slotsRaw =
    framePlan?.slots ??
    framePlan?.slotPlan?.slots ??
    extra?.slotPlan?.slots ??
    extra?.meta?.slotPlan?.slots ??
    null;

  if (!slotsRaw) return null;

  const out: Array<{ key: string; content: string }> = [];

  if (Array.isArray(slotsRaw)) {
    for (const s of slotsRaw) {
      const key = String(s?.key ?? s?.id ?? s?.slotId ?? s?.name ?? '').trim() || 'slot';
      const content = norm(s?.text ?? s?.value ?? s?.content ?? s?.message ?? s?.out ?? '');
      if (!content) continue;
      out.push({ key, content });
    }
  } else if (typeof slotsRaw === 'object') {
    for (const k of Object.keys(slotsRaw)) {
      const content = norm((slotsRaw as any)[k]);
      if (!content) continue;
      out.push({ key: String(k), content });
    }
  }

  return out.length ? out : null;
}

// ✅ renderEngine=true では 🪔 を絶対に出さない（本文混入も含めて落とす）
function stripLampEverywhere(text: string): string {
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  return t
    .replace(/^\s*🪔\s*$(\r?\n)?/gm, '')
    .replace(/[ \t]*🪔[ \t]*$/gm, '')
    .replace(/\n[ \t]*🪔[ \t]*(\n|$)/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/** ✅ SCAFFOLD は“定型句を足さない”。渡された本文を短く整形するだけ */
function minimalScaffold(baseText: string): RenderBlock[] {
  const lines = splitToLines(baseText);
  const out: RenderBlock[] = [];

  const a = stripInternalLabels(lines[0] ?? '');
  const b = stripInternalLabels(lines[1] ?? '');

  if (a) out.push({ text: a });
  if (b) out.push({ text: b });

  return out.slice(0, 2);
}

function getReplyProfileMaxLines(extra: any): number | null {
  const p =
    extra?.replyProfile ??
    extra?.meta?.replyProfile ??
    extra?.extra?.replyProfile ??
    extra?.orch?.replyProfile ??
    null;

  const n = Number(p?.maxLines);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function getSpeechInputLite(extra: any): {
  inputKind: string | null;
  brakeReleaseReason: string | null;
} {
  const si =
    extra?.speechInput ??
    extra?.meta?.speechInput ??
    extra?.extra?.speechInput ??
    extra?.orch?.speechInput ??
    null;

  const inputKind = si?.inputKind != null ? String(si.inputKind) : null;

  const brakeReleaseReason =
    (si?.brakeReleaseReason ?? si?.brake_reason ?? null) != null
      ? String(si.brakeReleaseReason ?? si.brake_reason)
      : (extra?.brakeReleaseReason ??
          extra?.brake_reason ??
          extra?.meta?.brakeReleaseReason ??
          extra?.meta?.brake_reason ??
          extra?.extra?.brakeReleaseReason ??
          extra?.extra?.brake_reason ??
          null) != null
        ? String(
            extra?.brakeReleaseReason ??
              extra?.brake_reason ??
              extra?.meta?.brakeReleaseReason ??
              extra?.meta?.brake_reason ??
              extra?.extra?.brakeReleaseReason ??
              extra?.extra?.brake_reason,
          )
        : null;

  return { inputKind, brakeReleaseReason };
}

function getSlotPlanPolicy(extra: any): string | null {
  const framePlan =
    extra?.framePlan ??
    extra?.meta?.framePlan ??
    extra?.extra?.framePlan ??
    extra?.orch?.framePlan ??
    null;

  const raw =
    framePlan?.slotPlanPolicy ??
    framePlan?.slotPlan?.slotPlanPolicy ??
    extra?.slotPlanPolicy ??
    extra?.meta?.slotPlanPolicy ??
    extra?.extra?.slotPlanPolicy ??
    null;

  const s = String(raw ?? '').trim();
  return s ? s : null;
}

function pickRephraseText(extra: any): string {
  const nrm = (s: any) => String(s ?? '').replace(/\r\n/g, '\n').trim();

  // 1) blocks 配列（もっとも確実）
  const blocks =
    (extra as any)?.rephraseBlocks ??
    (extra as any)?.rephrase?.blocks ??
    (extra as any)?.rephrase?.rephraseBlocks ??
    null;

  if (Array.isArray(blocks)) {
    const joined = blocks
      .map((b: any) => nrm(b?.text ?? b?.content ?? b))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (joined) return joined;
  }

  // 2) head 文字列
  const headText = nrm((extra as any)?.rephraseHead ?? (extra as any)?.rephrase?.head ?? (extra as any)?.rephrase_text);
  if (headText) return headText;

  return '';
}

/**
 * ✅ slot directives をUIに漏らさない最終ガード
 * - pickedFrom=slotPlanFallback 等で @ACK/@RESTORE/@Q が混ざっても、人間文へ
 */
function looksLikeSlotDirectives(s: string): boolean {
  if (!s) return false;
  return /(^|\s)@(?:ACK|RESTORE|SHIFT|Q)\s*\{/.test(s);
}

function extractFirstJsonObjectAfterTag(text: string, tag: string): string | null {
  const re = new RegExp(`(?:^|\\s)@${tag}\\s*\\{`, 'm');
  const m = re.exec(text);
  if (!m) return null;

  const start = m.index + m[0].lastIndexOf('{');
  let i = start;
  let depth = 0;

  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function safeJsonParse(jsonStr: string): any | null {
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * ✅ JSON.parse が死んでも「必要な1フィールドだけ」は拾う保険
 * - "ask":"..." / "last":"..." / "user":"..."
 */
function extractFieldFromTagFallback(text: string, tag: string, field: string): string {
  const re = new RegExp(String.raw`(?:^|\s)@${tag}\s*\{[\s\S]*?"${field}"\s*:\s*"([^"]*)"`, 'm');
  const m = re.exec(text);
  if (!m) return '';
  return (m[1] ?? '').trim();
}

function extractFieldAfterTag(text: string, tag: string, field: string): string {
  const jsonObjStr = extractFirstJsonObjectAfterTag(text, tag);
  if (jsonObjStr) {
    const obj = safeJsonParse(jsonObjStr);
    const v = typeof obj?.[field] === 'string' ? obj[field].trim() : '';
    if (v) return v;
  }
  return extractFieldFromTagFallback(text, tag, field);
}

function renderSlotDirectivesToHuman(directives: string): string {
  const user = extractFieldAfterTag(directives, 'ACK', 'user');
  const last = extractFieldAfterTag(directives, 'RESTORE', 'last');
  const ask = extractFieldAfterTag(directives, 'Q', 'ask');

  const lines: string[] = [];

  // ACK
  lines.push(user ? 'うん、覚えてる。' : 'うん。');

  // RESTORE
  if (last) {
    lines.push('');
    lines.push(`いまの焦点は「${last}」だね。`);
  }

  // Q（1問だけ）
  lines.push('');
  lines.push(ask || 'どの場面を指してる？');

  return lines.join('\n');
}

function finalizeNoDirectiveLeak(outText: string): string {
  if (!looksLikeSlotDirectives(outText)) return outText;
  return renderSlotDirectivesToHuman(outText);
}

/**
 * ✅ 追加：renderGateway の「選択元(pickedFrom)」をログと一致させるためのフォールバック取得
 * - rephrase が RECALL_GUARD で弾かれた場合など、route 側が slotPlanFallbackText を入れてくることがある
 * - ここを拾わないと、pickedFrom が "none/content/assistantText/text" に偽装される
 */
function pickSlotPlanFallbackText(extra: any): string {
  const nrm = (s: any) => String(s ?? '').replace(/\r\n/g, '\n').trim();

  const t =
    nrm((extra as any)?.slotPlanFallbackText) ||
    nrm((extra as any)?.meta?.slotPlanFallbackText) ||
    nrm((extra as any)?.extra?.slotPlanFallbackText) ||
    nrm((extra as any)?.orch?.slotPlanFallbackText);

  if (t) return t;

  // 保険：slotPlanFallback がオブジェクトで来る系
  const o =
    (extra as any)?.slotPlanFallback ??
    (extra as any)?.meta?.slotPlanFallback ??
    (extra as any)?.extra?.slotPlanFallback ??
    (extra as any)?.orch?.slotPlanFallback ??
    null;

  if (o && typeof o === 'object') {
    const t2 = nrm((o as any)?.text ?? (o as any)?.content ?? (o as any)?.assistantText ?? '');
    if (t2) return t2;
  }

  return '';
}

/**
 * ✅ 表示用サニタイズ
 * - enable=true/false どちらでも「人が読む文」に寄せるために使う
 * - 末尾🪔付与は「互換モード(renderEngine=false)」のときだけ opts.appendLamp=true で行う
 * - 重要：本文中の🪔は必ず除去し、付けるなら末尾だけ
 */
function sanitizeVisibleText(raw: string, opts?: { appendLamp?: boolean }): string {
  let s = String(raw ?? '').replace(/\r\n/g, '\n');

  // 1) ゼロ幅文字を除去（「空行に見える謎の行」の主因）
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // 2) 🪔は本文から全削除（混入事故を吸収）
  //    - enable=true でも false でも “本文に残さない”
  s = s.replace(/🪔/g, '');

  // 3) 行末空白除去
  s = s
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n');

  // 4) 句読点/記号だけの行を削除（「。」だけ等）
  const isPunctOnlyLine = (line: string) =>
    /^[\u3000\s]*[。．\.、,・:：;；!！\?？…]+[\u3000\s]*$/.test(line);

  s = s
    .split('\n')
    .filter((line) => !isPunctOnlyLine(line))
    .join('\n');

  // 5) 改行暴れ防止
  s = s.replace(/\n{3,}/g, '\n\n').trimEnd();

  // 6) 互換モードだけ末尾に🪔を付ける（末尾のみ）
  if (opts?.appendLamp) {
    if (s.length > 0 && !s.endsWith('\n')) s += '\n';
    s += '🪔';
  }

  return s;
}

export function renderGatewayAsReply(args: {
  extra?: any | null;
  content?: string | null;
  assistantText?: string | null;
  text?: string | null;
  maxLines?: number;
}): {
  content: string;
  meta: {
    blocksCount: number;
    maxLines: number;
    enable: boolean;

    pickedFrom: string;
    pickedLen: number;
    pickedHead: string;

    fallbackFrom: string;
    fallbackLen: number;
    fallbackHead: string;

    outLen: number;
    outHead: string;

    // ✅ Phase11 marker
    rev: string;
  };
} {
  const extra = args?.extra ?? {};
  const enable = extra?.renderEngine === true || String(extra?.renderEngine ?? '').toLowerCase() === 'true';

  const c1 = norm(args?.content ?? '');
  const c2 = norm(args?.assistantText ?? '');
  const c3 = norm(args?.text ?? '');

  // ✅ rephrase があるなら、それを最優先（slotplan由来のテンプレを上書き）
  const r0 = pickRephraseText(extra);

  // ✅ 追加：rephrase が弾かれたとき等の「slotPlanFallbackText」を拾う（ログ整合）
  const sf0 = pickSlotPlanFallbackText(extra);

  // ---- pick order（rephrase > content > assistantText > text > slotPlanFallback）
  let picked = r0 || c1 || c2 || c3 || sf0 || '';
  let pickedFrom = r0
    ? 'rephrase'
    : c1
      ? 'content'
      : c2
        ? 'assistantText'
        : c3
          ? 'text'
          : sf0
            ? 'slotPlanFallback'
            : 'none';


  // renderEngine 無効時は「触らず返す」（ただし互換のため末尾 🪔 は付ける）
  if (!enable) {
    // ※この分岐では renderV2 を通さず “そのまま見える文” に整えるだけ
    const visible = sanitizeVisibleText(picked, { appendLamp: true });

    return {
      content: visible,
      meta: {
        blocksCount: 0,
        maxLines: 0,
        enable: false,
        pickedFrom,
        pickedLen: picked.length,
        pickedHead: head(picked),
        fallbackFrom: 'n/a',
        fallbackLen: 0,
        fallbackHead: '',
        outLen: visible.length,
        outHead: head(visible),
        rev: IROS_RENDER_GATEWAY_REV,
      },
    };
  }

  const EXPAND_ENABLED = envFlagEnabled(process.env.IROS_RENDER_EXPAND_ENABLED, true);
  const DEFAULT_MAX_LINES =
    Number(process.env.IROS_RENDER_DEFAULT_MAXLINES) > 0 ? Number(process.env.IROS_RENDER_DEFAULT_MAXLINES) : 8;

  const { inputKind, brakeReleaseReason } = getSpeechInputLite(extra);

  const q1Suppress =
    brakeReleaseReason === 'Q1_SUPPRESS' ||
    String(extra?.silencePatchedReason ?? '').toUpperCase().includes('Q1_SUPPRESS') ||
    String(extra?.meta?.silencePatchedReason ?? '').toUpperCase().includes('Q1_SUPPRESS') ||
    String(extra?.extra?.silencePatchedReason ?? '').toUpperCase().includes('Q1_SUPPRESS');

  const isMicro = String(inputKind ?? '').toLowerCase() === 'micro';

  const profileMaxLines = getReplyProfileMaxLines(extra);
  const argMaxLines = Number(args?.maxLines) > 0 ? Math.floor(Number(args?.maxLines)) : null;

  const s4 = norm(extra?.speechSkippedText ?? '');
  const s5 = norm(extra?.rawTextFromModel ?? '');
  const s6 = norm(extra?.extractedTextFromModel ?? '');

  const slotExtracted = extractSlotBlocks(extra);
  const hasAnySlots = !!slotExtracted?.blocks?.length;

  const slotPlanPolicy = getSlotPlanPolicy(extra);

  // =========================================================
  // ✅ Phase11: 会話の強さ4条件ログ（UI非露出・1行でgrep判定）
  // =========================================================
  try {
    const evConversationId =
      extra?.conversationId ??
      extra?.meta?.conversationId ??
      extra?.extra?.conversationId ??
      extra?.orch?.conversationId ??
      null;

    const evUserCode =
      extra?.userCode ?? extra?.meta?.userCode ?? extra?.extra?.userCode ?? extra?.orch?.userCode ?? null;

    const evUserText =
      extra?.userText ?? extra?.meta?.userText ?? extra?.extra?.userText ?? extra?.orch?.userText ?? null;

    const evSignals =
      extra?.convSignals ??
      extra?.signals ??
      extra?.meta?.convSignals ??
      extra?.meta?.signals ??
      extra?.extra?.convSignals ??
      extra?.orch?.convSignals ??
      null;

    const evCtx =
      extra?.ctxPack ??
      extra?.contextPack ??
      extra?.meta?.ctxPack ??
      extra?.meta?.contextPack ??
      extra?.extra?.ctxPack ??
      extra?.orch?.ctxPack ??
      null;

    const evBranch =
      extra?.convBranch ??
      extra?.branch ??
      extra?.meta?.convBranch ??
      extra?.meta?.branch ??
      extra?.extra?.convBranch ??
      extra?.orch?.convBranch ??
      null;

    const evSlots = extractSlotsForEvidence(extra);

    const evMeta = {
      qCode: extra?.qCode ?? extra?.meta?.qCode ?? extra?.extra?.qCode ?? null,
      depthStage: extra?.depthStage ?? extra?.meta?.depthStage ?? extra?.extra?.depthStage ?? null,
      phase: extra?.phase ?? extra?.meta?.phase ?? extra?.extra?.phase ?? null,
    };

    // ✅ ctx.shortSummary を「確実に」埋める（evidenceLog.ts の判定を満たす）
    const rawCtx = evCtx as any;

    const ms: any =
      (extra as any)?.memoryState ??
      (extra as any)?.meta?.memoryState ??
      (extra as any)?.orch?.memoryState ??
      (extra as any)?.extra?.memoryState ??
      null;

    const situationSummaryText =
      (extra as any)?.situationSummary ??
      (extra as any)?.meta?.situationSummary ??
      (extra as any)?.orch?.situationSummary ??
      ms?.situation_summary ??
      ms?.situationSummary ??
      null;

    const summaryText =
      (extra as any)?.summary ?? (extra as any)?.meta?.summary ?? (extra as any)?.orch?.summary ?? ms?.summary ?? null;

    const derivedShortSummary =
      (typeof situationSummaryText === 'string' && situationSummaryText.trim()) ||
      (typeof summaryText === 'string' && summaryText.trim()) ||
      '';

    const evCtxFixed = {
      ...(rawCtx && typeof rawCtx === 'object' ? rawCtx : {}),
      shortSummary:
        rawCtx?.shortSummary && String(rawCtx.shortSummary).trim()
          ? rawCtx.shortSummary
          : derivedShortSummary || null,
    };

    logConvEvidence({
      conversationId: evConversationId,
      userCode: evUserCode,
      userText: typeof evUserText === 'string' ? evUserText : null,
      signals: evSignals,
      ctx: evCtxFixed,
      branch: evBranch,
      slots: evSlots,
      meta: evMeta,
    });
  } catch (e) {
    console.warn('[IROS/CONV_EVIDENCE][FAILED]', { error: e });
  }

  // fallbackText は “LLMが空のとき” の保険
  let fallbackText = picked || s4 || s5 || s6 || '';
  let fallbackFrom = picked
    ? pickedFrom
    : s4
      ? 'speechSkippedText'
      : s5
        ? 'rawTextFromModel'
        : s6
          ? 'extractedTextFromModel'
          : 'none';

  const isIR = looksLikeIR(fallbackText, extra);
  const isSilence = looksLikeSilence(fallbackText, extra);

  const shortException = isSilence || isMicro || q1Suppress;

  const maxLinesFinal = shortException
    ? 3
    : Math.max(1, Math.floor(profileMaxLines ?? argMaxLines ?? DEFAULT_MAX_LINES));

  // ✅ slots を本文に使うのは “LLM本文が完全に空” のときだけ（最終フォールバック）
  const shouldUseSlotsAsLastResort = !picked && hasAnySlots && !isSilence && !isIR && slotPlanPolicy === 'FINAL';

  let blocks: RenderBlock[] = [];
  let usedSlots = false;
  let scaffoldApplied = false;

  if (shouldUseSlotsAsLastResort) {
    blocks = slotExtracted!.blocks;
    usedSlots = true;
    fallbackText = fallbackText || blocks.map((b) => b.text).join('\n');
    fallbackFrom = fallbackFrom !== 'none' ? fallbackFrom : slotExtracted!.source;
  } else {
    const base = picked || fallbackText || '';

    const isScaffoldLike = slotPlanPolicy === 'SCAFFOLD' || (slotPlanPolicy == null && hasAnySlots && !picked);

    if (!isSilence && !isIR && isScaffoldLike) {
      blocks = minimalScaffold(base);
      scaffoldApplied = true;
    } else {
      const lines = splitToLines(base);
      blocks = lines
        .map((t) => stripInternalLabels(t))
        .filter(Boolean)
        .map((t) => ({ text: t }));
    }
  }

  const expandAllowed = EXPAND_ENABLED && !isSilence && !isIR;
  void expandAllowed; //（現状はログ用途のみ。将来分岐で使う）

  // ✅ 重要：rephrase は "picked" が最優先で拾っているので、
  // ここで extractedTextFromModel を直採用しない（directive漏れの温床になる）
  let content = renderV2({
    blocks,
    maxLines: maxLinesFinal,
    fallbackText,
    allowUnder5: shortException,
  });

  // ✅ 念のため：slot directive 行は最終表示に出さない（@OBS/@SHIFT/...）
  content = String(content ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^@(?:OBS|SHIFT|NEXT|SAFE|ACK|RESTORE|Q)\b/.test(t)) return false;
      return true;
    })
    .join('\n');




  // ✅ renderEngine=true のときは 🪔 を一切出さない（本文混入も含めて除去）
  content = stripLampEverywhere(content);

  // ✅ writer向け注釈を表示に出さない（整形のみ）
  // - [[/ILINE]] がある場合：そこ以降は全カット（writer注釈が後ろに付く前提）
  {
    const s = String(content ?? '').replace(/\r\n/g, '\n');

    const endTag = '[[/ILINE]]';
    const endIdx = s.indexOf(endTag);
    const cut = endIdx >= 0 ? s.slice(0, endIdx + endTag.length) : s;

    const lines = cut.split('\n');
    const filtered = lines.filter((line) => {
      const t = String(line ?? '').trim();
      if (!t) return true;
      if (t.startsWith('（writer向け）')) return false;
      if (t.includes('writer向け')) return false;
      if (t.includes('上の ILINE')) return false;
      return true;
    });

    while (filtered.length > 0 && String(filtered[filtered.length - 1] ?? '').trim() === '') {
      filtered.pop();
    }

    content = filtered.join('\n');
  }

  // ✅ ILINEタグは最終表示に出さない（整形のみ）
  // - ここは sanitize の前にやる（タグが残ると directive 検知に引っかかるため）
  content = String(content ?? '')
    .replace(/\[\[ILINE\]\]\s*\n?/g, '')
    .replace(/\n?\s*\[\[\/ILINE\]\]/g, '')
    .trim();

  // ✅ 最終表示テキストをサニタイズ（ゼロ幅/句読点だけ行/改行暴れ）
  // - renderEngine=true では末尾🪔は付けない
  content = sanitizeVisibleText(content);

  // ✅ 最終防衛：directive を人間文に変換（LLM落ち・rephrase reject 含む）
  // - ILINEタグは既に除去済みなので、ここでは「writer向け」や内部トークンだけを見る
  const hasDirectiveLeak =
    /\b(TASK|MODE|SLOT|META)\b/.test(content) ||
    /IROS\//.test(content) ||
    /（writer向け）/.test(content) ||
    /(^|\s)@(?:ACK|RESTORE|SHIFT|Q)\s*\{/.test(content);

  if (hasDirectiveLeak) {
    content = finalizeNoDirectiveLeak(content);
    content = sanitizeVisibleText(content); // 変換後の最低限整形
  }

  // ✅ 念のため最後にもう一回 🪔 を全除去（renderEngine=true の契約）
  content = stripLampEverywhere(content);

  // ✅ 末尾の空行を落とす
  content = String(content ?? '').replace(/(\n\s*)+$/g, '').trim();



  const meta = {
    blocksCount: blocks.length,
    maxLines: maxLinesFinal,
    enable: true,
    pickedFrom,
    pickedLen: picked.length,
    pickedHead: head(picked),
    fallbackFrom,
    fallbackLen: fallbackText.length,
    fallbackHead: head(fallbackText),
    outLen: norm(content).length,
    outHead: head(content),
    rev: IROS_RENDER_GATEWAY_REV,
  };

  // ✅ meta 拡張（破壊せず・型衝突させず）
  (meta as any).slotPlanPolicy =
    (args as any)?.slotPlanPolicy ??
    (args as any)?.meta?.slotPlanPolicy ??
    (meta as any)?.slotPlanPolicy ??
    null;

  // ✅ extra は「上書き」ではなく「合成」する（renderGateway内で足した値を消さない）
  {
    const extraFromArgs = (args as any)?.extra;
    const extraFromMeta = (args as any)?.meta?.extra;
    const extraPrev = (meta as any)?.extra;

    (meta as any).extra = {
      ...(typeof extraPrev === 'object' && extraPrev ? extraPrev : {}),
      ...(typeof extraFromMeta === 'object' && extraFromMeta ? extraFromMeta : {}),
      ...(typeof extraFromArgs === 'object' && extraFromArgs ? extraFromArgs : {}),
    };
  }


// ✅ render-v2 通電ランプ：rephraseBlocks が入っているか毎回見える化（スコープ/型安全版）
try {
  const extraAny = (meta as any)?.extra;
  const rephraseLen = Array.isArray(extraAny?.rephraseBlocks) ? extraAny.rephraseBlocks.length : 0;

  if (rephraseLen === 0) {
    console.warn('[IROS/renderGateway][WARN_NO_REPHRASE_BLOCKS]', {
      rev: meta.rev,
      hasExtra: !!extraAny,
      extraKeys: extraAny ? Object.keys(extraAny) : [],
      outLen: meta.outLen,
    });
  } else {
    console.info('[IROS/renderGateway][HAS_REPHRASE_BLOCKS]', {
      rev: meta.rev,
      rephraseBlocksLen: rephraseLen,
      outLen: meta.outLen,
    });
  }
} catch {}


  console.warn(
    '[IROS/renderGateway][OK]',
    JSON.stringify({
      rev: IROS_RENDER_GATEWAY_REV,
      outLen: meta.outLen,
      pickedFrom: meta.pickedFrom,
      slotPlanPolicy,
      usedSlots,
      scaffoldApplied,
      expandAllowed,
    }),
  );

  // ✅ Phase11 marker（ロード証明）
  console.warn('[IROS/renderGateway][REV]', JSON.stringify({ rev: IROS_RENDER_GATEWAY_REV }));

  return { content, meta };
}
