// src/lib/iros/language/renderGateway.ts
import { renderV2, type RenderBlock } from './renderV2';
import { logConvEvidence } from '../conversation/evidenceLog';
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
    const t2 = nrm((o as any)?.hintText ?? (o as any)?.text ?? (o as any)?.content ?? (o as any)?.assistantText ?? '');
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
  let s = String(raw ?? '');

  // 1) 改行統一
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ✅ 重要：本文中の🪔は必ず除去（付けるなら末尾だけ）
  s = s.replace(/🪔/g, '');

  // 2) Markdown見出し（### 等）を落とす：UIの見出し化を止める
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');

  // 3) 「**見出しだけ**」の行も “強調だけ” に落とす（UIで見出し扱いされるのを避ける）
  s = s.replace(/^\s*\*\*(.+?)\*\*\s*$/gm, '$1');

// ✅ iros の内部指示（slot directives）を UI に漏らさない最終ガード
// - 行内に @... が出た行は丸ごと落とす
function stripIrosDirectives(s0: string): string {
  const lines = String(s0 ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');

  const kept: string[] = [];
  for (const line0 of lines) {
    const line = String(line0 ?? '');
    // ✅ renderEngine=false 側でも漏れないように ACK/RESTORE/Q まで含める
    if (/@(?:OBS|CONSTRAINTS|SHIFT|NEXT|SAFE|ACK|RESTORE|Q)\b/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}


  // 3.5) iros 内部指示を落とす（UIに漏らさない）
  s = stripIrosDirectives(s);

  // 4) 行単位で整形：段落（空行）は残すが、連続空行は1個に潰す
  const isPunctOnly = (line: string) => {
    const t = line.trim();
    if (!t) return false;
    return /^[\p{P}\p{S}]+$/u.test(t);
  };

  const inLines = s.split('\n').map((line) => line.trimEnd());
  const outLines: string[] = [];

  for (const line of inLines) {
    const t = line.trim();

    if (isPunctOnly(line)) continue;

    if (!t) {
      if (outLines.length > 0 && outLines[outLines.length - 1] !== '') outLines.push('');
      continue;
    }

    outLines.push(line);
  }

  while (outLines.length > 0 && outLines[0] === '') outLines.shift();
  while (outLines.length > 0 && outLines[outLines.length - 1] === '') outLines.pop();

  s = outLines.join('\n');

  // 5) 改行暴れ防止（保険：3連以上は2連に）
  s = s.replace(/\n{3,}/g, '\n\n').trimEnd();

  // 6) 互換モードだけ末尾に 🪔 を付ける（末尾のみ）
  if (opts?.appendLamp) {
    if (s.length > 0 && !s.endsWith('\n')) s += '\n';
    s += '🪔';
  }

  return s;
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

function stripDirectiveLines(text: string): string {
  const s = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  // ✅ “行ごと”落とす（先頭だけ消えてJSON尻尾が残る事故を防ぐ）
  // - @TASK/@DRAFT などの directive 行は丸ごと削除
  // - INTERNAL PACK 行も丸ごと削除
  return s
    .split('\n')
    .filter((line) => {
      const t = String(line ?? '').trim();
      if (!t) return true;

      // ✅ directive line: drop whole line
      if (/^@(?:CONSTRAINTS|OBS|TASK|SHIFT|NEXT|SAFE|ACK|RESTORE|Q|DRAFT)\b/.test(t)) return false;

      // ✅ internal pack: drop whole line
      if (/^INTERNAL PACK\b/i.test(t)) return false;

      return true;
    })
    .join('\n')
    .trim();
}



function stripILINETags(text: string): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\[\[ILINE\]\]\s*\n?/g, '')
    .replace(/\n?\s*\[\[\/ILINE\]\]/g, '')
    .trim();
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
  // - content の「長さ」と「先頭(head)」だけを出す（本文を丸ごと出さない）
  const PIPE_ENABLED =
    process.env.IROS_RENDER_GATEWAY_PIPE === '1' ||
    process.env.IROS_RENDER_GATEWAY_PIPE === 'true' ||
    process.env.IROS_RENDER_GATEWAY_PIPE === 'on';

  const pipe = (label: string, s0: string) => {
    if (!PIPE_ENABLED) return;
    const s = String(s0 ?? '');
    console.info('[IROS/renderGateway][PIPE]', {
      label,
      len: s.length,
      head: head(s),
    });
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
      (extra as any)?.summary ??
      (extra as any)?.meta?.summary ??
      (extra as any)?.orch?.summary ??
      ms?.summary ??
      null;

    const derivedShortSummary =
      (typeof situationSummaryText === 'string' && situationSummaryText.trim()) ||
      (typeof summaryText === 'string' && summaryText.trim()) ||
      '';

    const evCtxFixed = {
      ...(rawCtx && typeof rawCtx === 'object' ? rawCtx : {}),
      shortSummary:
        rawCtx?.shortSummary && String(rawCtx.shortSummary).trim() ? rawCtx.shortSummary : derivedShortSummary || null,
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

    const isIR = looksLikeIR(fallbackText, extra);
    const isSilence = looksLikeSilence(fallbackText, extra);

    const shortException = isSilence || isMicro || q1Suppress;

    // ✅ ir診断は「本文を切らない」方針（render-v2 の maxLines で80字付近に落ちるのを防ぐ）
    // - profile/args が 16以上を指定していればそれを尊重
    // - 指定が無ければ最低16行は許可（DEFAULT_MAX_LINES=8 を上書き）
    const baseMaxLines = Math.floor(profileMaxLines ?? argMaxLines ?? DEFAULT_MAX_LINES);
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

      // ✅ 一本化：rephraseBlocks があれば常に blocks 経由で本文を組む（pickedFrom に依存しない）
      const cleanedBlocks = rephraseBlocks
        .map((b: any) => String(b?.text ?? b?.content ?? b ?? '').trim())
        .filter((t: string) => !isBadBlock(t))
        .map((t: string) => stripInternalLabels(t))
        .filter(Boolean)
        // ✅ 追加：renderV2 に渡す前に ILINE 末尾の writer 注釈を除去して “末尾切り事故” を防ぐ
        .map((t: string) => cutAfterIlineAndDropWriterNotes(t))
        .filter(Boolean)
        .map((t: string) => ({ text: t as string }));

      if (cleanedBlocks.length > 0) {
        blocks = cleanedBlocks;
        pickedFrom = 'rephraseBlocks';
      } else {
        // ✅ blocks が全部ダメなら通常ルート（最後尾の保険として r0s）
        const base2 = base || fallbackText || r0s || '';
        const lines = splitToLines(base2);
        blocks = lines
          .map((t) => stripInternalLabels(t))
          .filter(Boolean)
          .map((t) => ({ text: t }));
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

// ✅ renderV2 は「整形のみ」
// - blocks に含まれる内容を、そのまま安全に整形して返す
// - 勝手な短文化・行数制限・意味判断は一切行わない
// - 長文（将来の Sofia 10ブロック構成）にもそのまま対応できる
let content = renderV2({
  blocks,
  maxLines: maxLinesFinal,
  fallbackText,
});

pipe('after_renderV2', content);



  // ✅ renderV2 が空文字を返すケースを救済（blocks があるのに outLen=0 になる事故防止）
  if (String(content ?? '').trim() === '') {
    const blocksJoined = Array.isArray(blocks)
      ? blocks
          .map((b) => String((b as any)?.text ?? ''))
          .filter(Boolean)
          .join('\n')
      : '';

    const base = blocksJoined || fallbackText || r0s || picked || '';
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

  content = sanitizeVisibleText(content);
  pipe('after_sanitizeVisibleText', content);

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

  console.info('[IROS/renderGateway][LEN_TRACE]', {
    rev: IROS_RENDER_GATEWAY_REV,
    len_before: String(content ?? '').length,
    head_before: head(String(content ?? '')),
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

