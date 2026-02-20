// src/lib/iros/language/renderGateway.ts
import { renderV2, type RenderBlock } from './renderV2';
import { logConvEvidence } from '../conversation/evidenceLog';
import {
  stripInternalLabels,
  sanitizeVisibleText,
  stripDirectiveLines,
  stripILINETags,
} from './renderGateway.sanitize';
import { normalizeBlocksForRender } from './renderGateway.normalize';
import { shouldForceRephraseBlocks } from './renderGateway.rephrasePolicy';

// ---------------------------------------------
// IMPORTANT — DESIGN GUARD (DO NOT REDEFINE)
//
// This module is the final renderer for user-visible text.
// It must NOT:
// - leak internal labels/meta/protocol into user text
// - change philosophical/safety stance (user agency, SUN/north-star)
// - add “decision/diagnosis” behavior
//
// Render is responsible for presentation safety only.
// ---------------------------------------------

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

function looksLikeSilence(text: string, extra: any) {
  const t = norm(text);
  if (!t) return false;

  if (
    extra?.speechAct === '無言アクト' ||
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

  // 1) 本文に IR の構造ラベルが含まれるなら IR 本文
  if (t.includes('観測対象') && t.includes('フェーズ')) return true;
  if (t.includes('位相') && t.includes('深度')) return true;

  // 2) ✅ hint(IR) は「本文が空/ほぼ空」のときだけ補助的に使う
  //    （rephraseBlocks の詩文判定で hint が暴発して IR 扱いになるのを防ぐ）
  if (!t) {
    const hint = String(extra?.requestedMode ?? extra?.modeHint ?? extra?.mode ?? '').toUpperCase();
    if (hint.includes('IR')) return true;
  }

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

  // 優先順位：
  // 1) slotPlan（配列）… @NEXT_HINT 等が入っていて「前進」判定に効く
  // 2) slotPlan.slots（将来の形）
  // 3) framePlan.slots（hint を拾う）
  const slotsRaw =
    extra?.slotPlan ??
    extra?.meta?.slotPlan ??
    framePlan?.slotPlan?.slots ??
    extra?.slotPlan?.slots ??
    extra?.meta?.slotPlan?.slots ??
    framePlan?.slots ??
    null;

  if (!slotsRaw) return null;

  const out: Array<{ key: string; content: string }> = [];

  // slot が文字列で来るケースも拾う
  const pushSlot = (key0: any, content0: any) => {
    const key = String(key0 ?? '').trim() || 'slot';
    const content = norm(content0 ?? '');
    if (!content) return;
    out.push({ key, content });
  };

  if (Array.isArray(slotsRaw)) {
    for (const s of slotsRaw) {
      // 文字列（@NEXT_HINT ...）そのまま
      if (typeof s === 'string') {
        pushSlot('slot', s);
        continue;
      }

      // object slot
      const key = String(s?.key ?? s?.id ?? s?.slotId ?? s?.name ?? '').trim() || 'slot';

      // content 候補：slotPlan は text/value/content が多い / framePlan は hint
      const rawContent =
        s?.content ??
        s?.text ??
        s?.value ??
        s?.message ??
        s?.out ??
        s?.hint ?? // framePlan 対応
        '';

      // content が object の場合は最低限 stringify（ログ用）
      const content =
        rawContent && typeof rawContent === 'object' ? norm(JSON.stringify(rawContent)) : norm(rawContent);

      if (!content) continue;
      out.push({ key, content });
    }
  } else if (typeof slotsRaw === 'object') {
    // object map 形式（{OBS: "...", NEXT: "..."} など）
    for (const k of Object.keys(slotsRaw)) {
      pushSlot(k, (slotsRaw as any)[k]);
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
    const t2 = nrm((o as any)?.hintText ?? (o as any)?.text ?? (o as any)?.content ?? (o as any)?.assistantText ?? '');
    if (t2) return t2;
  }

  return '';
}

/** =========================================================
 * ✅ renderEngine=true 側の最終整形を “1本化” する
 * - 先に [[/ILINE]] 以降を切る（writer注釈が後ろに付く前提を生かす）
 * - slot directive 行を落とす
 * - ILINE タグを落とす（ここでだけ）
 * - sanitize でゼロ幅/句読点だけ行/🪔などを整える
 * ========================================================= */
function cutAfterIlineAndDropWriterNotes(text: string): string {
  const s = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const endTag = '[[/ILINE]]';
  const endIdx = s.indexOf(endTag);
  const cut = endIdx >= 0 ? s.slice(0, endIdx + endTag.length) : s;

  const lines = cut.split('\n');
  const kept = lines.filter((line) => {
    const t = String(line ?? '').trim();
    if (!t) return true;
    if (t.startsWith('（writer向け）')) return false;
    if (t.includes('writer向け')) return false;
    if (t.includes('上の ILINE')) return false;
    return true;
  });

  while (kept.length > 0 && String(kept[kept.length - 1] ?? '').trim() === '') kept.pop();
  return kept.join('\n');
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
  const extraAny = (args?.extra ?? {}) as any;
  const extra = extraAny;

  const enable = extra?.renderEngine === true || String(extra?.renderEngine ?? '').toLowerCase() === 'true';

  const c1 = norm(args?.content ?? '');
  const c2 = norm(args?.assistantText ?? '');
  const c3 = norm(args?.text ?? '');

  // ✅ debug pipe（任意ログ）
  // - デフォルトOFF（環境変数でON）
  // - 本文は出さず「長さ」と「先頭(head)」だけ出す
  // - 追加：段ごとのlenを貯めて、最後に LEN_FLOW を1回だけ吐く（重複防止）
  const PIPE_ENABLED =
    process.env.IROS_RENDER_GATEWAY_PIPE === '1' ||
    process.env.IROS_RENDER_GATEWAY_PIPE === 'true' ||
    process.env.IROS_RENDER_GATEWAY_PIPE === 'on';

  const STAGE_ENABLED =
    PIPE_ENABLED || // ✅ PIPE をONにしたら STAGE も自動ON（取りこぼし防止）
    process.env.IROS_RENDER_GATEWAY_STAGELOG === '1' ||
    process.env.IROS_RENDER_GATEWAY_STAGELOG === 'true' ||
    process.env.IROS_RENDER_GATEWAY_STAGELOG === 'on';

  const normLen = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim().length;

  // ✅ このターン内の「どこで縮んだか」を追う（本文は保存しない）
  const lenFlowSteps: Array<{ label: string; len: number; lenNorm: number; head: string }> = [];
  let lenFlowFlushed = false;

  const pipe = (label: string, s0: unknown, extra?: Record<string, any>) => {
    if (!PIPE_ENABLED && !STAGE_ENABLED) return;

    const s = String(s0 ?? '');
    const row = {
      label,
      len: s.length,
      lenNorm: normLen(s),
      head: head(s),
    };

    // 段ごとのlen/headを保存（LEN_FLOWで使う）
    if (!lenFlowFlushed) lenFlowSteps.push(row);

    // 既存互換：PIPEは従来どおり
    if (PIPE_ENABLED) {
      console.info('[IROS/renderGateway][PIPE]', {
        rev: IROS_RENDER_GATEWAY_REV,
        ...row,
        ...(extra ?? {}),
      });
    }

    // STAGE（任意）
    if (STAGE_ENABLED) {
      console.info('[IROS/renderGateway][STAGE]', {
        rev: IROS_RENDER_GATEWAY_REV,
        ...row,
        ...(extra ?? {}),
      });
    }
  };

  const flushLenFlow = (flushLabel: string, extra?: Record<string, any>) => {
    if (lenFlowFlushed) return; // ✅ 重複防止（ここがポイント）
    if (!PIPE_ENABLED && !STAGE_ENABLED) return;
    if (!lenFlowSteps.length) return;

    const steps = lenFlowSteps.map((r, i) => {
      const prev = i > 0 ? lenFlowSteps[i - 1] : null;
      return {
        label: r.label,
        len: r.len,
        lenNorm: r.lenNorm,
        head: r.head,
        delta: prev ? r.len - prev.len : 0,
        deltaNorm: prev ? r.lenNorm - prev.lenNorm : 0,
      };
    });

    const flow = steps.reduce<Record<string, { len: number; lenNorm: number; head: string }>>((acc, s) => {
      acc[s.label] = { len: s.len, lenNorm: s.lenNorm, head: s.head };
      return acc;
    }, {});

    console.info('[IROS/renderGateway][LEN_TRACE]', {
      rev: IROS_RENDER_GATEWAY_REV,
      flushLabel,
      steps,
      flow,
      ...(extra ?? {}),
    });

    lenFlowFlushed = true;
  };

  // ✅ rephrase があるなら、それを最優先（slotplan由来のテンプレを上書き）
  // ✅ rephraseText(r0) は「本文入力」ではなく “最終保険のfallback” として扱う
  // - render-v2 の本文は blocks（rephraseBlocks / splitToLines）で決める
  const r0 = pickRephraseText(extra);

  // ✅ 追加：rephrase が弾かれたとき等に [slotPlanFallbackText] を拾う（ログ整合）
  const sf0 = pickSlotPlanFallbackText(extra);

  // ✅ UI側の見出し化を避けるため、表示前に sanitize（見出し/段落の整形もここで）
  const r0s = r0 ? sanitizeVisibleText(r0, { appendLamp: false }) : '';
  const sf0s = sf0 ? sanitizeVisibleText(sf0, { appendLamp: false }) : '';

  // --- pick order (content > assistantText > text > slotPlanFallback)
  // ✅ 重要：本文は blocks 側で決めるため、ここで r0s を最優先にしない
  let picked = c1 || c2 || c3 || sf0s || '';
  let pickedFrom = c1
    ? 'content'
    : c2
    ? 'assistantText'
    : c3
    ? 'text'
    : sf0s
    ? 'slotPlanFallback'
    : 'none';

  // renderEngine 無効時は「触らず返す」（ただし互換のため末尾 🪔 は付ける）
  if (!enable) {
    // ※この分岐では renderV2 を通さず “そのまま見える文” に整えるだけ
    // ✅ 互換：rephraseText がある場合は、ここでは従来どおり優先してよい（v2未使用）
    const basePicked = r0s || picked || '';
    let visible = sanitizeVisibleText(basePicked, { appendLamp: true });

    // ✅ ガード/サニタイズで “空” になった場合は、rephraseBlocks から復旧する
    if (!visible && Array.isArray((extra as any)?.rephraseBlocks) && (extra as any).rephraseBlocks.length > 0) {
      const blocksJoined = (extra as any).rephraseBlocks
        .map((b: any) => String((b as any)?.text ?? b ?? '').trim())
        .filter(Boolean)
        .join('\n\n');

      if (blocksJoined) visible = sanitizeVisibleText(blocksJoined, { appendLamp: true });
    }

    return {
      content: visible,
      meta: {
        blocksCount: 0,
        maxLines: 0,
        enable: false,
        pickedFrom: r0s ? 'rephrase' : pickedFrom,
        pickedLen: basePicked.length,
        pickedHead: head(basePicked),
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

    const evUserCode = extra?.userCode ?? extra?.meta?.userCode ?? extra?.extra?.userCode ?? extra?.orch?.userCode ?? null;

    const evUserText = extra?.userText ?? extra?.meta?.userText ?? extra?.extra?.userText ?? extra?.orch?.userText ?? null;

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

      // ✅ meta は extra だけでなく ctxPack からも拾う（ここが null になってた）
      const rawCtx = evCtx as any;

      const evMeta = {
        qCode:
          extra?.qCode ??
          extra?.meta?.qCode ??
          extra?.extra?.qCode ??
          rawCtx?.qCode ??
          rawCtx?.meta?.qCode ??
          null,
        depthStage:
          extra?.depthStage ??
          extra?.meta?.depthStage ??
          extra?.extra?.depthStage ??
          rawCtx?.depthStage ??
          rawCtx?.meta?.depthStage ??
          null,
        phase:
          extra?.phase ??
          extra?.meta?.phase ??
          extra?.extra?.phase ??
          rawCtx?.phase ??
          rawCtx?.meta?.phase ??
          null,
      };

      // ✅ ctx.shortSummary を「確実に」埋める（evidenceLog.ts の判定を満たす）
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
        (extra as any)?.summary ??
        (extra as any)?.meta?.summary ??
        (extra as any)?.orch?.summary ??
        ms?.summary ??
        null;

      // ✅ ctxPack.historyDigestV1 を fallback に使う（ログ上 hasDigestV1 が true）
      const digestText =
        (rawCtx?.historyDigestV1 && typeof rawCtx.historyDigestV1 === 'object'
          ? (rawCtx.historyDigestV1.shortSummary ??
             rawCtx.historyDigestV1.summary ??
             rawCtx.historyDigestV1.digest ??
             null)
          : null) ?? null;

      const derivedShortSummary =
        (typeof situationSummaryText === 'string' && situationSummaryText.trim()) ||
        (typeof summaryText === 'string' && summaryText.trim()) ||
        (typeof digestText === 'string' && digestText.trim()) ||
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

  // fallbackText は “LLMが空のとき” の保険（r0s は最後尾保険）
  let fallbackText = picked || s4 || s5 || s6 || r0s || '';
  let fallbackFrom = picked
    ? pickedFrom
    : s4
    ? 'speechSkippedText'
    : s5
    ? 'rawTextFromModel'
    : s6
    ? 'extractedTextFromModel'
    : r0s
    ? 'rephrase'
    : 'none';

  // ✅ rephraseBlocks があるなら “実際の本文候補” を fallbackText にも反映
  // - IR判定/沈黙判定/短文例外の判定が、dotsや短いpickedに引っ張られるのを防ぐ
  try {
    const extraAny = extra as any;
    const rephraseBlocks =
      extraAny?.rephraseBlocks ??
      extraAny?.rephrase?.blocks ??
      extraAny?.rephrase?.rephraseBlocks ??
      null;

    if (Array.isArray(rephraseBlocks) && rephraseBlocks.length > 0) {
      const joined = rephraseBlocks
        .map((b: any) => String(b?.text ?? b?.content ?? b ?? '').trim())
        .filter(Boolean)
        .join('\n');

      // joined が取れたら優先（fallbackの意味を保つため、空のときは触らない）
      if (joined.trim().length > 0) {
        fallbackText = joined;
        fallbackFrom = 'rephraseBlocks';
      }
    }
  } catch {}

  const isIR = looksLikeIR(fallbackText, extra);
  const isSilence = looksLikeSilence(fallbackText, extra);

  const shortException = isSilence || isMicro || q1Suppress;


// ✅ maxLinesFinal（表示制約）
// - 通常は profile/args/default を尊重
// - ただし multi7（6ブロック: ENTRY..NEXT_MIN）など “ブロック数が多い” ときだけ最低行数を底上げして切断事故を防ぐ
const baseMaxLines0 = Math.floor(profileMaxLines ?? argMaxLines ?? DEFAULT_MAX_LINES);

// blockPlan / rephraseBlocks から「段構成の量」を推定（判断はしない。表示枠だけを確保する）
const rbLen = Array.isArray((extra as any)?.rephraseBlocks) ? (extra as any).rephraseBlocks.length : 0;
const bpMode = String((extra as any)?.blockPlan?.mode ?? (extra as any)?.blockPlanMode ?? '');
const isMulti7 = bpMode === 'multi7';

const baseMaxLines =
  !isIR && !shortException && (isMulti7 || rbLen >= 8)
    // ✅ multi7 は 6ブロック + 空行が入るので 14 だと「受容」で切れやすい。最低 28 行を確保する。
    ? Math.max(baseMaxLines0, 28)
    : baseMaxLines0;

const maxLinesFinal = isIR
  ? Math.max(16, Number.isFinite(baseMaxLines) && baseMaxLines > 0 ? baseMaxLines : 16)
  : shortException
  ? 3
  : Math.max(1, Number.isFinite(baseMaxLines) && baseMaxLines > 0 ? baseMaxLines : DEFAULT_MAX_LINES);


    // ✅ ir診断(seed-only) は LLM を呼ばない設計なので、
    //    SEED_TEXT がある場合のみ slots last resort を許可する
    const hasSeedText =
      Array.isArray((slotExtracted as any)?.keys) &&
      (slotExtracted as any).keys.some(
        (k: any) => String(k ?? '').toUpperCase() === 'SEED_TEXT',
      );

    // ✅ slots を本文に使うのは “LLM本文が完全に空” のときだけ（最終フォールバック）
    // - 通常は IR を除外（診断フォーマット混入を防ぐ）
    // - ただし IR でも SEED_TEXT のみは例外で許可（seed-only を画面に出すため）
    const shouldUseSlotsAsLastResort =
      !picked &&
      hasAnySlots &&
      !isSilence &&
      slotPlanPolicy === 'FINAL' &&
      (!isIR || hasSeedText);

    let blocks: RenderBlock[] = [];
    let usedSlots = false;
    let scaffoldApplied = false;


  if (shouldUseSlotsAsLastResort) {
    // ✅ slots last resort でも、内部ディレクティブ（@TASK/@CONSTRAINTS/...）を落としてから使う
    // - ここは isBadBlock/stripDirectiveLines の経路を通らないため、同等の安全化をここで行う
    const isBadDirective = (t0: string) => {
      const t = String(t0 ?? '').trim();
      if (!t) return true;
      if (/^@(?:CONSTRAINTS|TASK|OBS|SHIFT|NEXT|SAFE|ACK|RESTORE|Q)\b/.test(t)) return true;
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) return true;
      return false;
    };

    const cleaned = (slotExtracted!.blocks ?? [])
      .map((b: any) => String(b?.text ?? b?.content ?? b ?? '').trim())
      .filter((t: string) => !isBadDirective(t))
      .map((t: string) => stripDirectiveLines(t))
      .map((t: string) => stripInternalLabels(t))
      .map((t: string) => cutAfterIlineAndDropWriterNotes(t))
      .map((t: string) => String(t ?? '').trim())
      .filter(Boolean)
      .map((t: string) => ({ text: t }));

    blocks = cleaned.length > 0 ? cleaned : slotExtracted!.blocks;
    usedSlots = true;

    fallbackText = fallbackText || blocks.map((b) => b.text).join('\n');
    fallbackFrom = fallbackFrom !== 'none' ? fallbackFrom : slotExtracted!.source;
  } else {
    const base = picked || fallbackText || '';

    const isScaffoldLike = slotPlanPolicy === 'SCAFFOLD' || (slotPlanPolicy == null && hasAnySlots && !picked);

    // ✅ rephraseBlocks は block 意図を持つので splitToLines で潰さない
    const rephraseBlocks =
      extraAny?.rephraseBlocks ?? extraAny?.rephrase?.blocks ?? extraAny?.rephrase?.rephraseBlocks ?? null;

    const isBadBlock = (t0: string) => {
      const t = String(t0 ?? '').trim();
      if (!t) return true;
      // 先頭が @CONSTRAINTS/@OBS/... 系は “内部ディレクティブ”
      if (/^@(?:CONSTRAINTS|TASK|OBS|SHIFT|NEXT|SAFE|ACK|RESTORE|Q)\b/.test(t)) return true;
      // JSONっぽい塊も UI には出さない（だいたい directive の副産物）
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) return true;
      return false;
    };

    // ✅ IR（診断）では “診断フォーマット” を最優先で守る
    // - rephraseBlocks は本文を置換して短文化しやすい（今回 outLen=80 が発生）
    // - IR時は「短すぎる rephraseBlocks」を採用禁止にし、commit本文（base側）を勝たせる
    //
    // ✅ ただし「IRフォーマットを保持し、かつ短文化していない rephraseBlocks」なら採用してよい。
    // - route 側の fallback blocks（rephraseAttachSkipped=true）はもちろんOK
    // - それ以外でも、blocks 自体が IR 形式を保ち、かつ base本文に対して十分な長さならOK
    const blocksJoinedForIRCheck =
      Array.isArray(rephraseBlocks) && rephraseBlocks.length > 0
        ? rephraseBlocks
            .map((b: any) => String(b?.text ?? b?.content ?? b ?? '').trim())
            .filter(Boolean)
            .join('\n')
        : '';

    // ✅ IRの“基準本文”は extra.finalAssistantText（commit本文）があればそれを最優先
    // - これがあると「短い rephrase に負ける」事故を防げる
    const irBaseTextCandidate =
      (extraAny && typeof (extraAny as any).finalAssistantText === 'string' && (extraAny as any).finalAssistantText) ||
      (extraAny && typeof (extraAny as any).resolvedText === 'string' && (extraAny as any).resolvedText) ||
      base ||
      '';

    const irBaseText = isIR ? String(irBaseTextCandidate ?? '') : String(base ?? '');
    const irBaseLen = norm(irBaseText).length;
    const irJoinedLen = norm(blocksJoinedForIRCheck).length;

    // ✅ IR時の rephraseBlocks 採用条件：
    // 1) attachSkipped なら無条件でOK（route側の安全なfallback想定）
    // 2) それ以外は looksLikeIR を満たし、かつ「短文化していない」こと
    //    - 基準：base本文の 90% 以上（かつ最低120文字）
    const allowRephraseBlocksInIR =
      (Boolean((extraAny as any)?.rephraseAttachSkipped) &&
        Array.isArray(rephraseBlocks) &&
        rephraseBlocks.length > 0) ||
      (Array.isArray(rephraseBlocks) &&
        rephraseBlocks.length > 0 &&
        looksLikeIR(blocksJoinedForIRCheck, extra) &&
        irJoinedLen >= Math.max(120, Math.floor(irBaseLen * 0.9)));

    if (isIR && !allowRephraseBlocksInIR) {
      const lines = splitToLines(irBaseText);
      blocks = lines
        .map((t) => stripInternalLabels(t))
        .filter(Boolean)
        .map((t) => ({ text: t }));

      console.warn('[DEBUG/IR_BLOCK_PICK]', {
        isIR,
        rephraseAttachSkipped: Boolean((extraAny as any)?.rephraseAttachSkipped),
        rephraseBlocksLen: Array.isArray(rephraseBlocks) ? rephraseBlocks.length : 0,
        allowRephraseBlocksInIR,
        irBaseLen,
        irJoinedLen,
        baseHead: irBaseText.slice(0, 140),
        joinedHead: blocksJoinedForIRCheck.slice(0, 140),
      });
    } else if (Array.isArray(rephraseBlocks) && rephraseBlocks.length > 0) {
      // ✅ rephraseBlocks 経由でも UI に「ブロック扱い」を伝える
      usedSlots = true;
      pickedFrom = 'rephraseBlocks';
      scaffoldApplied = isScaffoldLike;
      // ✅ 一本化：rephraseBlocks があれば常に blocks 経由で本文を組む（pickedFrom に依存しない）
      const cleanedBlocksRaw = rephraseBlocks
        .map((b: any) => String(b?.text ?? b?.content ?? b ?? '').trim())
        // ✅ 追加：advance計測用の内部ブロックは UI に出さない
        .filter((t: string) => !t.trimStart().startsWith('@NEXT_HINT'))
        .filter((t: string) => !isBadBlock(t))
        .map((t: string) => stripInternalLabels(t))
        .filter(Boolean)
        // ✅ 追加：renderV2 に渡す前に ILINE 末尾の writer 注釈を除去して “末尾切り事故” を防ぐ
        .map((t: string) => cutAfterIlineAndDropWriterNotes(t))
        .filter(Boolean);

// ✅ 表現レーン preface を “rephraseBlocks 採用時” にも 1行だけ先頭付与する
// - base(resultObjFinalRaw) には preface が残るが、UI は rephraseBlocks を採用するため消える
{
  // 1行に潰す（ローカル定義：この関数内だけで完結させる）
  const clampOneLineLocal = (s: string) =>
    String(s ?? '')
      .replace(/\s+/g, ' ')
      .trim();

  const exprPrefaceRaw = clampOneLineLocal(
    String((extraAny as any)?.expr?.prefaceLine ?? (extraAny as any)?.expr?.prefaceHead ?? ''),
  );
  const exprPreface = exprPrefaceRaw;

  const shouldPrependPrefaceToBlocks = (preface: string, head: string, exAny: any) => {
    if (!preface) return false;
    if (!head) return true;
    if (head === preface) return false;
    if (head.startsWith(preface)) return false;
    return true;
  };

  const cleanedBlocksWithPreface = (cleanedBlocksRaw: string[]) => {
    if (!exprPreface) return cleanedBlocksRaw;
    const head = String(cleanedBlocksRaw?.[0] ?? '').trim();
    if (shouldPrependPrefaceToBlocks(exprPreface, head, extraAny)) {
      (extraAny as any).exprPrefaceApplied = true;
      return [exprPreface, ...cleanedBlocksRaw];
    }
    // 既に入っている場合も “適用済み扱い” にして二重適用事故を根絶
    (extraAny as any).exprPrefaceApplied = true;
    return cleanedBlocksRaw;
  };

  // ✅ まず「テキスト配列」を作る（cleanedBlocksText をここで定義する）
  const rbTexts = rephraseBlocks
    .map((b: any) => String(b?.text ?? b?.content ?? b ?? '').trim());

  const rbTotal = rbTexts.length;
  const rbEmpty = rbTexts.filter((t) => !t).length;
  const rbNextHint = rbTexts.filter((t) => t.trimStart().startsWith('@NEXT_HINT')).length;
  const rbBad = rbTexts.filter((t) => t && isBadBlock(t)).length;

  const cleanedBlocksText = rbTexts
    // advance計測用の内部ブロックは UI に出さない
    .filter((t: string) => t && !t.trimStart().startsWith('@NEXT_HINT'))
    .filter((t: string) => !isBadBlock(t))
    .map((t: string) => stripInternalLabels(t))
    .filter(Boolean)
    // ILINE 末尾の writer 注釈を除去して “末尾切り事故” を防ぐ
    .map((t: string) => cutAfterIlineAndDropWriterNotes(t))
    .filter(Boolean);

  const rbKept = cleanedBlocksText.length;
  const rbKeptJoinedLen = norm(cleanedBlocksText.join('\n')).length;

  // ✅ 後段ログで参照できるように meta.extra に“診断情報”を保持（表示には使わない）
  try {
    (extraAny as any).renderMeta = {
      ...((extraAny as any).renderMeta ?? {}),
      rbDiag: {
        rbTotal,
        rbEmpty,
        rbNextHint,
        rbBad,
        rbKept,
        rbKeptJoinedLen,
      },
    };
  } catch {}
}


    } else {

      // 通常ルート
      const lines = splitToLines(base);
      blocks = lines
        .map((t) => stripInternalLabels(t))
        .filter(Boolean)
        .map((t) => ({ text: t }));
    }

    // ✅ SCAFFOLD は“定型句を足さない”。渡された本文を短く整形するだけ
    if (isScaffoldLike && blocks.length === 0) {
      blocks = minimalScaffold(base);
      scaffoldApplied = true;
    }

  }

  const expandAllowed = EXPAND_ENABLED && !isSilence && !isIR;
  void expandAllowed; //（現状はログ用途のみ。将来分岐で使う）

// ❌ 以前はここで「短くしてよいか」を判断していたが、これは renderGateway の責務ではない
// - 行数・長さの判断は slotPlan / orchestrator の単一正に集約する
// - 下流（render）は一切判断しないことで、LLMが迷わない状態を保証する

  // ✅ FIX: rephraseBlocks があるのに blocks が空のときは、fallbackText に落とさず blocks として採用する
  // - 今回の SHORT_OUT_DIAG: blocksCount=0 / rephraseBlocksLen>0 / pickedFrom=text が発生していた
  // - fallbackText 経由だと改行が潰れて短文化しやすいので、blocks を優先する
  let blocksForRender = blocks;
  let fallbackTextForRender: string | null = fallbackText ?? null;
  let pickedFromForRender = pickedFrom;

  // ✅ @NEXT_HINT は UI に出さないが、「最小の一手」の本文補完に使えるので保持する
  // - rb（rephraseBlocks）ではなく “slotPlan 側” に入っているので、まず slotPlan から拾う
  let nextHintFromSlotPlan: string | null = null;

  const tryPickNextHintFromSlots = (exAny: any): string | null => {
    try {
      const slots = extractSlotsForEvidence(exAny);
      if (!Array.isArray(slots) || slots.length === 0) return null;

      // slotPlan 配列の中に "@NEXT_HINT {...json...}" がそのまま入ってくる
      const raw = slots
        .map((s) => String((s as any)?.content ?? '').trim())
        .find((t) => t.trimStart().startsWith('@NEXT_HINT'));

      if (!raw) return null;

      const jsonPart = String(raw).replace(/^@NEXT_HINT\s*/i, '').trim();
      const obj = JSON.parse(jsonPart);
      const h = String(obj?.hint ?? '').trim();
      return h ? h : null;
    } catch {
      return null;
    }
  };

  // まず slotPlan から拾う（ここが正）
  nextHintFromSlotPlan = tryPickNextHintFromSlots(extraAny);

  // （互換用）rb から拾える場合もあるかもしれないので一応残すが、基本は slotPlan 優先
  let nextHintFromRb: string | null = null;

  try {
    const prevPickedFrom = pickedFrom;
    const rb = Array.isArray((extraAny as any)?.rephraseBlocks) ? (extraAny as any).rephraseBlocks : null;
    const rbLen2 = rb ? rb.length : 0;

    if (
      shouldForceRephraseBlocks({
        isIR,
        isSilence,
        rephraseBlocksLen: rbLen2,
        hasBlocks: !!(blocksForRender && blocksForRender.length > 0),
        extra: extraAny,
      })
    ) {
      // まず raw text を全部取り出す
      const rbAllTexts = rb
        .map((b: any) => String(b?.text ?? b?.content ?? b ?? '').replace(/\r\n/g, '\n').trim())
        .filter(Boolean);

      // rb 由来は “あったら拾う” 程度（無ければ slotPlan の hint を使う）
      if (!nextHintFromSlotPlan) {
        const nextHintRaw = rbAllTexts.find((t: string) => t.trimStart().startsWith('@NEXT_HINT'));
        if (nextHintRaw) {
          const jsonPart = String(nextHintRaw).replace(/^@NEXT_HINT\s*/i, '').trim();
          try {
            const obj = JSON.parse(jsonPart);
            const h = String(obj?.hint ?? '').trim();
            if (h) nextHintFromRb = h;
          } catch {
            // JSON じゃない形で来たときは本文として扱わない（無理に入れない）
          }
        }
      }

      const rbTexts = rbAllTexts
        // @NEXT_HINT は UI に出さない（存在しても本文に混ぜない）
        .filter((t: string) => !String(t ?? '').trimStart().startsWith('@NEXT_HINT'))
        // 末尾切り事故防止のガードはここで継続
        .map((t: string) => cutAfterIlineAndDropWriterNotes(stripInternalLabels(t)))
        .filter(Boolean) as string[];

      if (rbTexts.length > 0) {
        // ✅ rephraseBlocks-forced の場合：
        // - rbTexts が「1要素=巨大ブロック（中に ### 見出しが複数）」で来ることがある（AUTO_PATCH: NEXT_MIN_ONLY 等）
        // - そのまま blocks 化すると「見出しだけで本文ゼロ」判定になって blocks=0 になる事故が出る
        // → ここで rbTexts を “行トークン” に展開してから同じ畳み込みロジックで処理する

        const headingForKey = (k: string | null): string | null => {
          const key = String(k ?? '').trim().toUpperCase();
          if (!key) return null;
          if (key === 'ENTRY') return '入口';
          if (key === 'SITUATION') return '状況';
          if (key === 'DUAL') return '二項';
          if (key === 'FOCUS_SHIFT') return '焦点移動';
          if (key === 'ACCEPT') return '受容';
          if (key === 'INTEGRATE') return '統合';
          if (key === 'CHOICE') return '選択';
          if (key === 'NEXT_MIN') return '最小の一手';
          return null;
        };

        const isHeaderish = (t: string) => {
          const s = String(t ?? '').trim();
          return (
            /^#{1,6}\s+\S+/.test(s) || // ### 見出し
            /^(入口|状況|二項|焦点移動|受容|統合|選択|最小の一手)$/.test(s) // 文字見出し
          );
        };

        // ====== 置き換え：extractHeadingTitle と pickDynamicTitle ======

        // ✅ 同一ターン内の「見出し語」使い回し防止
        const usedTitleHints = new Set<string>();

        const extractHeadingTitle = (t: string): string | null => {
          const s = String(t ?? '').trim();
          if (!s) return null;

          // ### 見出し
          const m = s.match(/^#{1,6}\s+(.+)\s*$/);
          const titleRaw = m && m[1] ? String(m[1]).trim() : null;

          // 文字見出し
          if (
            !titleRaw &&
            /^(入口|状況|二項|焦点移動|受容|統合|選択|最小の一手)$/.test(s)
          )
            return s;
          if (!titleRaw) return null;

          // ✅ 「入口：月食」みたいな“固定：可変”が来たら、
          //   「入口/状況/…」側を落として「月食」だけ返す（= 一行可変見出し）
          const mm = titleRaw.match(
            /^(入口|状況|二項|焦点移動|受容|統合|選択)\s*：\s*(.+)$/
          );
          if (mm && mm[2]) return String(mm[2]).trim();

          return titleRaw;
        };

        const pickDynamicTitle = (base: string | null, bodyText: string): string | null => {
          const b = String(base ?? '').trim();
          if (!b) return null;

          // ✅ 「最小の一手」だけは固定（既存ガード整合）
          if (b.includes('最小の一手')) return '最小の一手';

          const s = String(bodyText ?? '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .trim();

          // ---- 本文から「見出し候補」を複数抽出して、未使用のものを採用する ----
          const stop = new Set([
            'こと',
            'もの',
            'これ',
            'それ',
            'ため',
            '感じ',
            '瞬間',
            '現象',
            '私たち',
            'あなた',
            '今日',
            'ここ',
            'そこ',
            '月',
            '太陽',
            '地球', // 天体連打しやすいので弱ストップ（必要なら外してOK）
          ]);

          const push = (arr: string[], v: string | undefined | null) => {
            const x = String(v ?? '').trim();
            if (!x) return;
            if (x.length < 2) return;
            if (x.length > 12) return;

            // ✅ 見出し候補は「漢字 or カタカナ」に限定（断片見出しを防ぐ）
            // 例: "中で新しい理解が待っ"（ひらがな混じり）を弾く
            if (!/^[一-龥ァ-ヶー]{2,12}$/.test(x)) return;

            if (stop.has(x)) return;
            if (/^(入口|状況|二項|焦点移動|受容|統合|選択)$/.test(x)) return;
            arr.push(x);
          };

          const pickTopicHints = (text: string): string[] => {
            const out: string[] = [];
            const t = String(text ?? '').trim();
            if (!t) return out;

            // ① 既知ワード（強いイベント語など）
            const knownAll = t.match(
              /(月食|日食|新月|満月|地震|台風|仕事|会議|上司|恋愛|結婚|別れ|不安|恐れ|怒り|静寂|調和|再生|影|秩序)/g
            );
            if (knownAll) knownAll.forEach((x) => push(out, x));

            // ② 「XのY」→ Y を拾う（“宇宙の秩序”→“秩序” など）
            const reNo = /([一-龥ぁ-んァ-ヶ]{2,10})の([一-龥ぁ-んァ-ヶ]{2,10})/g;
            let m: RegExpExecArray | null;
            while ((m = reNo.exec(t))) push(out, m[2]);

            // ③ 漢字名詞っぽい塊（2〜8）
            const reKanji = /([一-龥]{2,8})/g;
            while ((m = reKanji.exec(t))) push(out, m[1]);

            // ④ カタカナ名詞
            const reKata = /([ァ-ヶー]{3,12})/g;
            while ((m = reKata.exec(t))) push(out, m[1]);

            // 重複排除（順序保持）
            return Array.from(new Set(out));
          };

          const candidates = s ? pickTopicHints(s) : [];

          // ✅ “一行可変” を強くする：未使用の候補を選ぶ（同語連打を止める）
          const picked = candidates.find((x) => !usedTitleHints.has(x)) ?? null;
          if (picked) {
            usedTitleHints.add(picked);
            return picked; // ← 「topicだけ」を返す（入口/状況…は出さない）
          }

          // すでに使い切った/候補が取れない：保険で base を返す（入口/状況…など）
          return b;
        };

        // ✅ rb（生配列）も参照して key が取れるなら最優先（互換用：ただし index ずれがあるので今回は “見出し無し本文” の fallback にだけ使う）
        const rbRaw = Array.isArray((extraAny as any)?.rephraseBlocks)
          ? ((extraAny as any).rephraseBlocks as any[])
          : null;

        // ✅ key が無い場合：multi8 の順番（＝枠は固定、見出しは可変にしてOK）
        const fallbackOrder = [
          '入口',
          '状況',
          '二項',
          '焦点移動',
          '受容',
          '統合',
          '選択',
          '最小の一手',
        ] as const;

        // ✅ 重要：rbTexts（ブロック）→ 行トークンへ展開（AUTO_PATCHの巨大ブロック対策）
        const rbTokens: string[] = [];
        for (const raw of rbTexts) {
          const t = String(raw ?? '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .trim();
          if (!t) continue;

          for (const line of t.split('\n')) {
            const x = String(line ?? '').trim();
            if (!x) continue;
            // 念のため：ここでも @NEXT_HINT は排除（混入ケース対策）
            if (x.trimStart().startsWith('@NEXT_HINT')) continue;
            rbTokens.push(x);
          }
        }

        const blocks: Array<{ text: string }> = [];
        let sectionIndex = 0;

        for (let i = 0; i < rbTokens.length; i++) {
          const cur = String(rbTokens[i] ?? '').trim();
          if (!cur) continue;

          // ✅ 見出し → 次の本文（次の見出しまで）をまとめて 1 ブロック化
          if (isHeaderish(cur)) {
            const bodies: string[] = [];
            let j = i + 1;
            while (j < rbTokens.length) {
              const nxt = String(rbTokens[j] ?? '').trim();
              if (!nxt) {
                j++;
                continue;
              }
              if (isHeaderish(nxt)) break;
              bodies.push(nxt);
              j++;
            }

            const baseTitle =
              extractHeadingTitle(cur) ??
              (sectionIndex < fallbackOrder.length ? fallbackOrder[sectionIndex] : null);

            const title = pickDynamicTitle(baseTitle, bodies.join('\n'));

// ✅ 見出しだけ残る事故を防ぐ：本文が無ければ出さない
if (title && bodies.length > 0) {
  // ✅ rephraseBlocks-forced: 見出し（###）は付けない。
  // ✅ ただし「✨」等の装飾は render で固定しない（writer/expr側へ委譲）
  {
    const body = bodies.join('\n\n').trim();
    if (body) {
      blocks.push({ text: body }); // ✅ FIX: emoji/prefix を注入しない
    }
  }
  sectionIndex++;
} else if (!title && bodies.length > 0) {
  // タイトル不明だが本文がある：壊さず本文だけ出す
  blocks.push({ text: bodies.join('\n\n') });
  sectionIndex++;

}
i = j - 1; // まとめた分だけ進める
continue;
}

// ✅ 見出しが無い本文だけが来た場合：fallback で 1 ブロック化
// rbRaw は index がズレることがあるので “あくまで補助”
const keyFromRb =
  rbRaw && Array.isArray(rbRaw) && rbRaw[sectionIndex] && typeof rbRaw[sectionIndex] === 'object'
    ? (rbRaw[sectionIndex] as any)?.key ?? (rbRaw[sectionIndex] as any)?.id ?? null
    : null;

const h1 = headingForKey(keyFromRb);
const h2 = !h1 && sectionIndex < fallbackOrder.length ? fallbackOrder[sectionIndex] : null;
const baseHeading = h1 ?? h2;

const heading = baseHeading ? pickDynamicTitle(baseHeading, cur) : null;

if (heading) {
  // ✅ rephraseBlocks-forced: 見出し（###）は付けない。
  // ✅ ただし「✨」等の装飾は render で固定しない（writer/expr側へ委譲）
  {
    const body = String(cur ?? '').trim();
    if (body) {
      blocks.push({ text: body }); // ✅ FIX: emoji/prefix を注入しない
    }
  }
} else {
  blocks.push({ text: cur });
}
sectionIndex++;
        }

        blocksForRender = blocks;

        // null を入れると型で落ちることがあるので空文字にする（fallbackは「無効化」）
        fallbackTextForRender = '';

        // pickedFrom（診断・ログ・後段）も“強制側”に合わせる
        pickedFromForRender = 'rephraseBlocks-forced';
        pickedFrom = pickedFromForRender;

        console.warn('[IROS/renderGateway][FORCE_BLOCKS_FROM_REPHRASE]', {
          rev: IROS_RENDER_GATEWAY_REV,
          rbLen: rbLen2,
          forcedBlocks: blocksForRender.length,
          prevPickedFrom: prevPickedFrom,
          nextHintFromRb: nextHintFromRb,
          nextHintFromSlotPlan: nextHintFromSlotPlan,
        });
      }


    }
  } catch {}


// ====== 置き換え②：最小の一手の補完で使う hint ソース ======
//
// 対象（現状）
// 1574: const hint = String(nextHintFromRb ?? '').trim();
//
// を、以下に置き換え
//

  // slotPlan 優先（正）、無ければ rb（互換）を使う
  const hint = String(nextHintFromSlotPlan ?? nextHintFromRb ?? '').trim();


// ✅ DIAG: rephraseBlocks の実体確認（multi7が最後まで入っているか）
try {
  const rb = Array.isArray((extraAny as any)?.rephraseBlocks) ? (extraAny as any).rephraseBlocks : null;
  const rbTexts = Array.isArray(rb)
    ? rb
        .map((b: any) => String(b?.text ?? b?.content ?? b ?? '').trim())
        .filter(Boolean)
    : [];

  console.warn('[IROS/renderGateway][RB_CONTENT_DIAG]', {
    rev: IROS_RENDER_GATEWAY_REV,
    rbLen: rbTexts.length,
    joinedLen: rbTexts.join('\n').length,
    head1: rbTexts[0]?.slice(0, 80) ?? null,
    head2: rbTexts[1]?.slice(0, 80) ?? null,
    tail2: rbTexts.length >= 2 ? rbTexts[rbTexts.length - 2]?.slice(0, 80) : null,
    tail1: rbTexts.length >= 1 ? rbTexts[rbTexts.length - 1]?.slice(0, 80) : null,
  });
} catch {}

// ✅ renderV2 は「整形のみ」
// - blocks に含まれる内容を、そのまま安全に整形して返す
// - 勝手な短文化・行数制限・意味判断は一切行わない
// - 長文（将来の Sofia 10ブロック構成）にもそのまま対応できる

// ✅ FIX: rephraseBlocks を強制した場合、multi 構成が maxLinesFinal(例:14) で切れやすい。
// ここは「内容判断」ではなく「整形上の行数上限」なので、十分な上限を確保する。
const maxLinesForRender =
  pickedFromForRender === 'rephraseBlocks-forced'
    ? Math.max(Number(maxLinesFinal ?? 0) || 0, 80)
    : maxLinesFinal;

// ✅ DROP_EMPTY_NEXT_MIN:
// 「最小の一手」の見出しだけが残る事故（本文欠落）を UI から隠す。
// ただし「見出し＋本文が同一ブロック内」に入っている場合は削除しない。
try {
  const isNextMinHeaderLine = (s: string) => {
    const t = String(s ?? '').trim();
    const tt = t
      .replace(/^#{1,6}\s*/u, '')
      .replace(/^[✨⭐️🌟🔸🔹・•\-–—]+\s*/u, '')
      .trim();
    return /^最小の一手/.test(tt);
  };

  const isHeaderLine = (s: string) => /^###\s+/.test(String(s ?? '').trim());

  const blockHasBodyInside = (blockText: string) => {
    const lines = String(blockText ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((x) => String(x ?? '').trim())
      .filter(Boolean);

    // 先頭が「最小の一手」見出しで、2行目以降に本文がある（=同一ブロック内に本文がある）
    if (lines.length >= 2 && isNextMinHeaderLine(lines[0])) {
      // 2行目が別見出しなら本文なし扱い
      return !isHeaderLine(lines[1]);
    }
    return false;
  };

  if (Array.isArray(blocksForRender) && blocksForRender.length > 0) {
    const idx = blocksForRender.findIndex((b: any) => {
      const text = String(b?.text ?? '');
      const firstLine = text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')[0] ?? '';
      return isNextMinHeaderLine(firstLine);
    });

    if (idx >= 0) {
      const curText = String((blocksForRender[idx] as any)?.text ?? '');

      // ✅ 同一ブロック内に本文があるなら、削除しない
      if (!blockHasBodyInside(curText)) {
        // 次のブロックに本文があるか判定（従来ロジック）
        let j = idx + 1;
        while (
          j < blocksForRender.length &&
          String((blocksForRender[j] as any)?.text ?? '').trim() === ''
        ) {
          j++;
        }

        const nextText =
          j < blocksForRender.length ? String((blocksForRender[j] as any)?.text ?? '') : '';
        const missingBody = j >= blocksForRender.length || isHeaderLine(nextText);

        if (missingBody) {
          blocksForRender = blocksForRender
            .slice(0, idx)
            .concat(blocksForRender.slice(idx + 1));
        }
      }
    }
  }
} catch {}


let content = renderV2({
  blocks: blocksForRender,
  maxLines: maxLinesForRender,
  fallbackText: fallbackTextForRender,
});

pipe('after_renderV2', content);

function trimTo60(s: string): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= 60) return t;
  return t.slice(0, 60) + '…';
}

// ✅ FIX: 「最小の一手」セクションが無い/本文が無い場合、@NEXT_HINT を一文化して補完する（ラベル可変）
try {
  const hint = String(nextHintFromSlotPlan ?? nextHintFromRb ?? '').trim();

  const lines = String(content ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');

  // ✅ ラベル可変（UI側の見出し名）
  // この地点では meta 変数は未定義になりやすいので、args.meta を直接見る
  const metaArg = (args as any)?.meta ?? null;

  // ✅ extra は “未定義変数” を踏むと即死するので、metaArg から安全に取る
  const extraArg = (metaArg as any)?.extra ?? null;

  const goalKind = String(
    extraArg?.goalKind ??
      extraArg?.replyGoal?.kind ??
      extraArg?.replyGoalKind ??
      metaArg?.framePlan?.goalKind ??
      metaArg?.goalKind ??
      ''
  ).trim();

  const decideNextLabel = (k: string) => {
    const kk = String(k ?? '').trim();
    switch (kk) {
      case 'uncover':
        return '次の一手';
      case 'stabilize':
      case 'reframeIntention':
      default:
        return 'ここから';
    }
  };

  const nextLabel = decideNextLabel(goalKind);

  // ✅ “同義” 扱いする既存ラベル（入力側の揺れ吸収）
  const NEXT_LABELS = ['最小の一手', '次の一手', 'ここから', 'NEXT', 'NEXT_MIN', 'NEXT_HINT'];

  const isNextHeader = (s: string) => {
    const t = String(s ?? '').trim();
    if (/^###\s*/.test(t)) {
      const head = t.replace(/^###\s*/, '').trim();
      return NEXT_LABELS.some((x) => head === x);
    }
    if (/^✨\s*/.test(t)) {
      const head = t.replace(/^✨\s*/, '').trim();
      return NEXT_LABELS.some((x) => head === x);
    }
    return NEXT_LABELS.some((x) => t === x);
  };

  const isHeaderLine = (s: string) => {
    const t = String(s ?? '').trim();
    return /^###\s+/.test(t) || /^✨\s+/.test(t);
  };

  const idx = lines.findIndex(isNextHeader);

  // ✅ NEXT を表示するか（このスコープで必ず定義する）
  const flowDelta = String(extraArg?.flow?.flowDelta ?? '').trim();
  const returnStreak = Number(extraArg?.flow?.returnStreak ?? 0);

  // RETURN 直後は「ここから」を見せたいので NEXT を出す（好みで調整可）
  const shouldShowNext = flowDelta === 'RETURN' ? true : returnStreak >= 2;

  const hintFinal = hint && shouldShowNext ? String(hint) : '';

  const trimTo60 = (s: string): string => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    if (t.length <= 60) return t;
    return t.slice(0, 60) + '…';
  };

  if (!hintFinal) {
    // ✅ hint を出さない場合でも、既存セクションがあればラベルだけ統一する
    if (idx >= 0) {
      const headLine = String(lines[idx] ?? '').trim();
      if (/^###\s*/.test(headLine)) lines[idx] = `### ${nextLabel}`;
      else if (/^✨\s*/.test(headLine)) lines[idx] = `✨ ${nextLabel}`;
      else lines[idx] = nextLabel;

      // 見出しだけ（本文なし）のときだけ削除
      let end = idx + 1;
      while (end < lines.length && !isHeaderLine(lines[end])) end++;

      const hasBody = lines
        .slice(idx + 1, end)
        .some((s) => {
          const t = String(s ?? '').trim();
          return t.length > 0 && !isHeaderLine(t);
        });

      if (!hasBody) {
        lines.splice(idx, end - idx);
      }
      content = lines.join('\n').trim();
    }
  } else {
    const sentence = trimTo60(hintFinal);

    // 見出しが無い → 末尾にセクション追加（可変ラベル）
    if (idx < 0) {
      while (lines.length > 0 && String(lines[lines.length - 1]).trim() === '') lines.pop();
      lines.push('', `### ${nextLabel}`, '', sentence);
      content = lines.join('\n').trim();
    } else {
      // ✅ 既存見出しは UI ラベルに統一
      const headLine = String(lines[idx] ?? '').trim();
      if (/^###\s*/.test(headLine)) lines[idx] = `### ${nextLabel}`;
      else if (/^✨\s*/.test(headLine)) lines[idx] = `✨ ${nextLabel}`;
      else lines[idx] = nextLabel;

      // 本文が無い → 直下に挿入
      let j = idx + 1;
      while (j < lines.length && String(lines[j]).trim() === '') j++;

      const missingBody = j >= lines.length || isHeaderLine(lines[j]);
      if (missingBody) {
        lines.splice(idx + 1, 0, '', sentence);
      }
      content = lines.join('\n').trim();
    }
  }
} catch (e) {
  console.warn('[IROS/renderGateway][NEXT_LABEL_PATCH_FAILED]', { error: e });
}



  // ✅ blocks を「表示前に」軽く正規化（重複/見出し/空行だけ整える）
  try {
    const blocksIn = Array.isArray(blocksForRender)
      ? blocksForRender.map((b: any) => String(b?.text ?? '').trim()).filter(Boolean)
      : [];

    if (blocksIn.length > 0) {
      const normRes = normalizeBlocksForRender(blocksIn, {
        titleScanMaxLines: 3,
        dedupeConsecutiveTitles: true,
        maxBlankRun: 1,
        dedupeExactBlocks: true,
      });

      if (Array.isArray(normRes?.blocks) && normRes.blocks.length > 0) {
        blocksForRender = normRes.blocks.map((t) => ({ text: t }));
      }

      // ✅ 変化があった時だけ必ずログ（STAGE_ENABLED OFFでも追える）
      const m = normRes?.meta ?? null;
      const changed =
        !!m &&
        ((m.removedExactDups ?? 0) > 0 ||
          (m.removedTitleDups ?? 0) > 0 ||
          (m.trimmedBlankRuns ?? 0) > 0 ||
          (m.inBlocks ?? 0) !== (m.outBlocks ?? 0));

      if (changed || STAGE_ENABLED) {
        console.warn('[IROS/renderGateway][NORMALIZE_DIAG]', {
          rev: IROS_RENDER_GATEWAY_REV,
          meta: m,
          inBlocks: blocksIn.length,
          outBlocks: Array.isArray(normRes?.blocks) ? normRes.blocks.length : 0,
        });
      }
    }
  } catch {}


// ✅ renderV2 が空文字を返すケースを救済（blocks があるのに outLen=0 になる事故防止）
if (String(content ?? '').trim() === '') {
  const blocksJoinedForRescue = Array.isArray(blocksForRender)
    ? blocksForRender
        .map((b) => String((b as any)?.text ?? ''))
        .filter(Boolean)
        .join('\n')
    : '';

  const base = blocksJoinedForRescue || fallbackTextForRender || r0s || picked || '';
  content = base;
  fallbackFrom = 'renderV2-empty';
}
pipe('after_renderV2_empty_rescue', content);

  // =========================================================
  // ✅ 最終表示の整形（重複排除版）
  // - 1) [[/ILINE]] 以降を切る（writer注釈対策）
  // - 2) directive 行を落とす（@ACK/@RESTORE/@Q含む）
  // - 3) ILINE タグを落とす（ここでだけ）
  // - 4) sanitize（ゼロ幅/句読点だけ行/改行暴れ/🪔除去）
  // =========================================================
  content = cutAfterIlineAndDropWriterNotes(content);
  pipe('after_cutAfterIlineAndDropWriterNotes', content);

  content = stripDirectiveLines(content);
  pipe('after_stripDirectiveLines', content);

  content = stripILINETags(content);
  pipe('after_stripILINETags', content);

  // ✅ 最終 sanitize
  // - rephraseBlocks 採用時は「多段の改行」を潰さない（ENTRY/DUAL/...の構造を保持）
  const pickedFromFinal =
    String((extra as any)?.renderMeta?.pickedFrom ?? (extra as any)?.pickedFrom ?? (extra as any)?.meta?.pickedFrom ?? '');

  const preserveNewlines =
    pickedFromFinal === 'rephraseBlocks' ||
    Array.isArray((extra as any)?.rephraseBlocks) ||
    Array.isArray((extra as any)?.rephrase?.blocks) ||
    Array.isArray((extra as any)?.rephrase?.rephraseBlocks);

  if (preserveNewlines) {
    // 改行は維持しつつ、危険要素だけ落とす（ゼロ幅・directive・ILINEなどは前段で処理済み）
    content = String(content ?? '')
      .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '') // zero-width
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+\n/g, '\n') // 行末の空白だけ除去
      .replace(/\n{4,}/g, '\n\n\n') // 改行暴れだけ抑える（2〜3段は残す）
      .trim();
  } else {
    content = sanitizeVisibleText(content);
  }
  pipe('after_sanitizeVisibleText', content);


  // ✅ 追加：strip/sanitize の結果 “空に戻った” 場合の救済（UI空事故を塞ぐ）
  if (String(content ?? '').trim() === '') {
    const rescueBase = String(fallbackText || r0s || picked || '');
    const rescue = sanitizeVisibleText(
      stripILINETags(stripDirectiveLines(cutAfterIlineAndDropWriterNotes(rescueBase))),
    );
    content = rescue || '';
    fallbackFrom = fallbackFrom || 'post_sanitize_empty';
  }
  pipe('after_post_sanitize_empty_rescue', content);


  // ✅ 最終防衛：directive を人間文に変換（LLM落ち・rephrase reject 含む）
  const hasDirectiveLeak =
    /\b(TASK|MODE|SLOT|META)\b/.test(content) ||
    /IROS\//.test(content) ||
    /（writer向け）/.test(content) ||
    /(^|\s)@(?:ACK|RESTORE|SHIFT|Q)\s*\{/.test(content);

  pipe('directiveLeak_check', content);

  if (hasDirectiveLeak) {
    content = finalizeNoDirectiveLeak(content);
    content = sanitizeVisibleText(content);
    pipe('after_finalizeNoDirectiveLeak', content);
  }

  // ✅ 念のため最後にもう一回 🪔 を全除去（renderEngine=true の契約）
  content = stripLampEverywhere(content);
  pipe('after_stripLampEverywhere', content);

  // ✅ 末尾の空行を落とす
  content = String(content ?? '').replace(/(\n\s*)+$/g, '').trim();
  pipe('after_trim', content);

    // ✅ NO-ECHO 止血：
  // - rephraseBlocks がある（= 何か出そうとしている）
  // - しかし表示可能な本文が無く（NEXT_HINT しかない等）
  // - その結果 pickedFrom='text' で userText がそのまま本文になってしまう
  // → このケースは「空ではない」ので RESCUED_EMPTY が動かず、オウムになる。ここで止血する。
  try {
    const userText0 =
      norm(
        extra?.userText ??
          extra?.meta?.userText ??
          extra?.extra?.userText ??
          extra?.orch?.userText ??
          '',
      ) || '';

    const pickedFrom0 = String(pickedFrom ?? '');
    const content0 = norm(content ?? '');

    const rephraseBlocks0 = (extra as any)?.rephraseBlocks ?? null;

    const hasBlocks = Array.isArray(rephraseBlocks0) && rephraseBlocks0.length > 0;

    // blocks から “見える本文” を作る（NEXT_HINT/内部指示は落とす）
    let visibleFromBlocks = '';
    if (hasBlocks) {
      const joined = rephraseBlocks0
        .map((b: any) => String(b?.text ?? b?.content ?? b ?? '').trim())
        .filter(Boolean)
        .join('\n');

      visibleFromBlocks = joined;
      visibleFromBlocks = stripDirectiveLines(visibleFromBlocks);
      visibleFromBlocks = visibleFromBlocks
        .split('\n')
        .map((t: string) => String(t ?? '').trim())
        .filter((t: string) => t && !t.trimStart().startsWith('@NEXT_HINT'))
        .join('\n');
      visibleFromBlocks = sanitizeVisibleText(visibleFromBlocks);
      visibleFromBlocks = stripLampEverywhere(visibleFromBlocks);
      visibleFromBlocks = String(visibleFromBlocks ?? '').trim();
    }

    const looksLikeEcho =
      pickedFrom0 === 'text' &&
      userText0.length > 0 &&
      content0.length > 0 &&
      content0 === userText0 &&
      hasBlocks &&
      visibleFromBlocks === '';

    if (looksLikeEcho) {
      // userText に倒さず、slotPlanFallback → fallbackText → ACK の順で救出
      const rescueCandidate =
        norm(sf0s) ||
        norm(fallbackText) ||
        norm(r0s) ||
        'うん、届きました。';

      content = String(rescueCandidate ?? '').trim();
      // meta 整合のため、picked/pickedFrom も同期する
      picked = content;
      pickedFrom = norm(sf0s) ? 'slotPlanFallback' : norm(fallbackText) ? 'fallbackText' : 'ack';

      console.warn('[IROS/renderGateway][NO_ECHO_FIX]', {
        rev: IROS_RENDER_GATEWAY_REV,
        pickedFrom_before: pickedFrom0,
        userLen: userText0.length,
        outLen: String(content ?? '').length,
        outHead: head(String(content ?? '')),
        blocksLen: hasBlocks ? rephraseBlocks0.length : 0,
      });
    }
  } catch {}


  // ✅ meta は「実際に採用された見える本文」に合わせる
  // - pickedFrom='rephraseBlocks' のとき、picked/baseText が省略文字や短いダミーになることがある
  // - その場合 meta の pickedHead/pickedLen がズレて解析が誤読するので、常に content 優先で補正する
  // ✅ meta は「実際に採用された見える本文」に合わせる
  // - pickedFrom='rephraseBlocks' のとき、picked/baseText が省略文字や短いダミーになることがある
  // - その場合 meta の pickedHead/pickedLen がズレて解析が誤読するので、常に content 優先で補正する
  const pickedRaw = String(picked ?? '');
  const contentRaw = String(content ?? '');

  const pickedForMeta =
    String(pickedFrom ?? '') === 'rephraseBlocks' && norm(contentRaw).length > 0
      ? contentRaw
      : pickedRaw;

  // ✅ blocksCount は「最終的に render に渡す blocks（= blocksForRender）」で数える
      const blocksCountForMeta = Array.isArray(blocksForRender) ? blocksForRender.length : 0;

      const meta = {
        blocksCount: Array.isArray(blocksForRender) ? blocksForRender.length : 0,
        maxLines: maxLinesFinal,
        enable: true,
        pickedFrom,
        pickedLen: norm(pickedForMeta).length,
        pickedHead: head(pickedForMeta),
        fallbackFrom,
        fallbackLen: norm(fallbackText).length,
        fallbackHead: head(fallbackText),

        // ✅ outLen は “最終表示” の生文字数で統一（enable=false と同じ定義）
        outLen: String(contentRaw).length,
        outHead: head(contentRaw),
        rev: IROS_RENDER_GATEWAY_REV,
      };


  // ✅ 短文化の“確定ログ”：render側が切ったのか、blocks側が短いのかを一発で判定する
  try {
    const rbDiag = (meta as any)?.extra?.renderMeta?.rbDiag ?? null;

    const pickedFromStr = String(pickedFrom ?? '');

    // ✅ rephraseBlocks 強制ターンは “短文化事故” ではないことが多いので除外
    const isForcedBlocks =
      pickedFromStr === 'rephraseBlocks-forced' || pickedFromStr.startsWith('rephraseBlocks');

    // IR / shortException は対象外（意図的に短い場合がある）
    const isShortOut =
      !isIR &&
      !shortException &&
      !isForcedBlocks &&
      Number.isFinite(meta.outLen) &&
      meta.outLen > 0 &&
      meta.outLen < 160;

    if (isShortOut) {
      console.warn('[IROS/renderGateway][SHORT_OUT_DIAG]', {
        rev: IROS_RENDER_GATEWAY_REV,
        slotPlanPolicy,
        pickedFrom,
        fallbackFrom,
        maxLinesFinal,
        blocksCount: blocksCountForMeta,
        outLen: meta.outLen,
        outHead: meta.outHead,
        rbDiag,
        // 追加で「最終採用品質」も一緒に見る
        pickedLen: meta.pickedLen,
        pickedHead: meta.pickedHead,
        fallbackLen: meta.fallbackLen,
        fallbackHead: meta.fallbackHead,
      });
    }
  } catch {}


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

  // ✅ 追跡ログ：meta の picked が content に同期されているか確認
  {
    const fixed = pickedForMeta !== pickedRaw;
    if (fixed) {
      console.info('[IROS/renderGW][META_PICKED_FIX]', {
        rev: IROS_RENDER_GATEWAY_REV,
        pickedFrom,
        pickedLen_raw: norm(pickedRaw).length,
        pickedHead_raw: head(pickedRaw),
        pickedLen_meta: norm(pickedForMeta).length,
        pickedHead_meta: head(pickedForMeta),
        outLen: norm(contentRaw).length,
        outHead: head(contentRaw),
      });
    }
  }

  console.info('[IROS/renderGateway][LEN_SNAPSHOT]', {
    rev: IROS_RENDER_GATEWAY_REV,
    len_before: String(contentRaw).length,
    head_before: head(String(contentRaw)),
  });


// ✅ 最終保険：最終整形で空になったら、必ず復旧して返す（ILINE/指示行は落とした状態で）
if (String(content ?? '').trim() === '') {
  // まずは従来の救出素材
  let rescueBase = picked || fallbackText || r0 || c1 || c2 || c3 || '';

  // ✅ 追加：rephraseBlocks があるのに “pickedFrom:'text' で空” を救えないケースの止血
  // - ただし @OBS/@SHIFT 等の内部ディレクティブは UI に出さない（stripDirectiveLines で落とす）
  if (String(rescueBase ?? '').trim() === '') {
    try {
      const extraAny2 = (meta as any)?.extra as any;
      const rephraseBlocks = extraAny2?.rephraseBlocks ?? null;

      if (Array.isArray(rephraseBlocks) && rephraseBlocks.length > 0) {
        const joined = rephraseBlocks
          .map((b: any) => String(b?.text ?? b?.content ?? b ?? '').trim())
          .filter(Boolean)
          .join('\n');

        rescueBase = joined || rescueBase;
      }
    } catch {}
  }

  let rescued = rescueBase;

  // renderEngine=true の契約（ILINE/指示/🪔/writer注釈を落とす）を守って復旧
  rescued = cutAfterIlineAndDropWriterNotes(rescued);
  rescued = stripDirectiveLines(rescued);
  rescued = stripILINETags(rescued);
  rescued = sanitizeVisibleText(rescued);
  rescued = stripLampEverywhere(rescued);

  content = String(rescued ?? '').replace(/(\n\s*)+$/g, '').trim();

  // ✅ それでも空なら「空返しだけは防ぐ」最終ACK
  if (String(content ?? '').trim() === '') {
    content = 'うん、届きました。🪔';
  }

  console.warn('[IROS/renderGateway][RESCUED_EMPTY]', {
    rev: IROS_RENDER_GATEWAY_REV,
    rescueLen: content.length,
    rescueHead: head(content),
  });
}



  // ✅ render-v2 通電ランプ：rephraseBlocks が入っているか毎回見える化（スコープ/型安全版）
  try {
    const extraAny2 = (meta as any)?.extra;
    const rephraseLen = Array.isArray(extraAny2?.rephraseBlocks) ? extraAny2.rephraseBlocks.length : 0;

    if (rephraseLen === 0) {
      console.warn('[IROS/renderGateway][WARN_NO_REPHRASE_BLOCKS]', {
        rev: meta.rev,
        hasExtra: !!extraAny2,
        extraKeys: extraAny2 ? Object.keys(extraAny2) : [],
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

  if (STAGE_ENABLED) {
    try {
// ✅ LEN_FLOW も「最終的に render に渡す blocks（= blocksForRender）」を参照する
const blocksJoined = Array.isArray(blocksForRender)
  ? blocksForRender
      .map((b: any) => String(b?.text ?? b?.content ?? b ?? '').trim())
      .filter(Boolean)
      .join('\n')
  : '';

const blocksCountForLog = Array.isArray(blocksForRender) ? blocksForRender.length : 0;



      console.info('[IROS/renderGateway][LEN_FLOW]', {
        rev: IROS_RENDER_GATEWAY_REV,
        slotPlanPolicy,
        pickedFrom,
        fallbackFrom,
        maxLinesFinal,
        blocksCount: blocksCountForLog,
        isIR,
        isSilence,
        shortException,

        // ✅ raw（素材）: ここは “指示文/slotPlan由来の拾い物” が入る
        pickedRawLen: norm(picked).length,
        pickedRawHead: head(String(picked ?? '')),

        // ✅ blocks（renderV2の材料）: blocksForRender を join したもの
        blocksJoinedLen: blocksJoined.length,
        blocksJoinedHead: head(blocksJoined),



        // ✅ final（確定本文）: renderV2 → strip/sanitize → trim 後の content
        finalLen: norm(String(content ?? '')).length,
        finalHead: head(String(content ?? '')),

        // ✅ fallbackText（保険）
        fallbackLen: norm(fallbackText).length,
        fallbackHead: head(String(fallbackText ?? '')),

        // ✅ サマリ辞書（詳細steps/deltaは LEN_TRACE 側）
        flow: Object.fromEntries(
          lenFlowSteps.map((s) => [s.label, { len: s.len, lenNorm: s.lenNorm, head: s.head }]),
        ),
      });
    } catch (e) {
      console.warn('[IROS/renderGateway][LEN_FLOW][FAILED]', { error: e });
    }
  }

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

  // ✅ 重要：pickedFrom=rephraseBlocks のとき、commit本文（extra.finalAssistantText）が “……” のまま残ると
  // route 側の永続化が “……” を選んでしまう。ここで確定本文を同期して止血する。
  try {
    const extraAny = (meta as any)?.extra as any;
    const pickedFrom = String((meta as any)?.pickedFrom ?? '');
    const c = String(content ?? '').trim();

    if (extraAny && pickedFrom === 'rephraseBlocks' && c) {
      const prev = String(extraAny.finalAssistantText ?? '').trim();

      const prevLooksEmptyLike =
        prev === '' ||
        prev === '…' ||
        prev === '……' ||
        prev === '...' ||
        prev === '..' ||
        prev.length <= 2;

      if (prevLooksEmptyLike) {
        // 永続化で参照されがちなキー群を “確定本文” に寄せる（directive は content 側で既に除去済み）
        extraAny.finalAssistantText = c;
        extraAny.finalAssistantTextCandidate = c;
        extraAny.assistantText = c;
        extraAny.resolvedText = c;
        extraAny.rawTextFromModel = c;
        extraAny.extractedTextFromModel = c;

        // ✅ 追加：Len 系も同期（finalAssistantTextLen が 2 のまま残る事故を止血）
        extraAny.finalAssistantTextLen = c.length;
        extraAny.finalAssistantTextCandidateLen = c.length;
        extraAny.assistantTextLen = c.length;
        extraAny.resolvedTextLen = c.length;
        extraAny.rawTextFromModelLen = c.length;
        extraAny.extractedTextFromModelLen = c.length;

        // 追跡用（既存の分析には影響しない文字列フラグ）
        extraAny.finalTextPolicy = 'RENDERGW__SYNC_FROM_REPHRASE';
      }
    }
  } catch {}

  return { content, meta };
}

