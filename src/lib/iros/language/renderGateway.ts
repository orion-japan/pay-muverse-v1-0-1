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
 * ✅ 内部ラベル完全除去（最終責任）
 * - system/protocol/hint 由来のタグや、メタ説明行を本文から消す
 * - “意味を壊さず短く” を優先
 * ========================================================= */
function stripInternalLabels(line: string): string {
  let s = norm(line);

  // 🪔は残す（ただし本文中に混ざってたら ensureEndSymbol で末尾に統一する）
  s = s.trim();
  if (!s) return '';

  // 1) 角括弧ラベル（例：【WRITER_PROTOCOL】など）
  s = s.replace(/【[^】]{1,24}】/g, '').trim();

  // 2) writer hint / meta説明
  s = s.replace(/^writer hint[:：]\s*/i, '').trim();

  // 2.5) 先頭の「… / ...」はノイズ
  s = s.replace(/^(\.{3,}|…{1,})\s*/g, '').trim();
  if (s === '...' || s === '…' || /^\.{3,}$/.test(s) || /^…+$/.test(s)) return '';

  if (/^FRAME\s*=\s*.*$/i.test(s) && !/[。！？!?]/.test(s)) return '';
  if (/^SLOTS\s*=\s*.*$/i.test(s) && !/[。！？!?]/.test(s)) return '';

  s = s.replace(/^FRAME\s*=\s*\S+\s*/i, '').trim();
  s = s.replace(/^SLOTS\s*=\s*\S+\s*/i, '').trim();

  if (
    /^(OBS_META|ROTATION_META|IT_HINT|ANCHOR_CONFIRM|TURN_MODE|SUBMODE)\s*[:：].*$/i.test(s) &&
    !/[。！？!?]/.test(s)
  ) {
    return '';
  }

  s = s
    .replace(/^(OBS_META|ROTATION_META|IT_HINT|ANCHOR_CONFIRM|TURN_MODE|SUBMODE)\s*[:：]\s*/i, '')
    .trim();

  if (
    /(phase\s*=|depth\s*=|q\s*=|spinloop\s*=|spinstep\s*=|descentgate\s*=|tLayerHint\s*=|itx_|slotPlanPolicy|slotSeed|llmRewriteSeed)/i.test(
      s,
    )
  ) {
    if (s.includes('=') || s.includes(':') || s.includes('：')) return '';
  }

  s = s.replace(/^[〔\[]sa[\w.\s-]+[〕\]]$/i, '').trim();
  s = s.replace(/\s{2,}/g, ' ').trim();

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
  const t = norm(text);
  if (!t) return [];

  const rawLines = t
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

  if (rawLines.length === 1) {
    const one = rawLines[0];

    const parts0 = one
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

    if (one.length >= 26 && one.includes('、')) {
      const i = one.indexOf('、');
      const a = one.slice(0, i + 1).trim();
      const b = one.slice(i + 1).trim();
      return [a, b].filter(Boolean);
    }

    if (one.length >= 34) {
      const mid = Math.min(22, Math.floor(one.length / 2));
      const a = one.slice(0, mid).trim();
      const b = one.slice(mid).trim();
      return [a, b].filter(Boolean);
    }
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
    const ORDER = ['OBS', 'SHIFT', 'NEXT', 'SAFE', 'INSIGHT', 'opener', 'facts', 'mirror', 'elevate', 'move', 'ask', 'core', 'add'];

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

/** ✅ 🪔 は “末尾の1行” に統一（本文に混ざっていても無視して最後に付ける）
 * - maxLines に達していても「最後の行を🪔に置換」して必ず残す
 */
function ensureEndSymbol(blocks: RenderBlock[], maxLines: number) {
  // 本文中の🪔は落とす（最終行にだけ置く）
  for (const b of blocks) {
    const t = norm((b as any)?.text ?? '');
    if (!t) continue;
    (b as any).text = t.replace(/🪔/g, '').trim();
  }

  // 空行を除いた現在行数
  const nonEmptyIdx: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (norm(blocks[i]?.text)) nonEmptyIdx.push(i);
  }

  // そもそも何もない場合は🪔だけ
  if (nonEmptyIdx.length === 0) {
    blocks.push({ text: '🪔' });
    return;
  }

  const lastIdx = nonEmptyIdx[nonEmptyIdx.length - 1];
  const lastText = norm(blocks[lastIdx]?.text);

  // すでに末尾が🪔ならOK
  if (lastText === '🪔') return;

  // 行数に余裕があるなら追加
  if (nonEmptyIdx.length < maxLines) {
    blocks.push({ text: '🪔' });
    return;
  }

  // 行数が上限なら「最後の非空行を🪔に置換」
  blocks[lastIdx] = { text: '🪔' };
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
    extra?.framePlan ?? extra?.meta?.framePlan ?? extra?.extra?.framePlan ?? extra?.orch?.framePlan ?? null;

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
  const headText = nrm(
    (extra as any)?.rephraseHead ??
      (extra as any)?.rephrase?.head ??
      (extra as any)?.rephrase_text,
  );
  if (headText) return headText;

  return '';
}

/** ✅ SCAFFOLD は“定型句を足さない”。渡された本文を短く整形するだけ */
function minimalScaffold(baseText: string): RenderBlock[] {
  const lines = splitToLines(baseText);
  const out: RenderBlock[] = [];

  const a = stripInternalLabels(lines[0] ?? '');
  const b = stripInternalLabels(lines[1] ?? '');

  if (a) out.push({ text: a });
  if (b) out.push({ text: b });

  // 2行 + 🪔（最大3行想定）
  ensureEndSymbol(out, 3);

  // 念のためクリーニング
  const cleaned = out
    .map((x) => ({ text: stripInternalLabels(String((x as any)?.text ?? '')) }))
    .filter((x) => Boolean(norm(x.text)));

  if (cleaned.length <= 3) return cleaned;
  return cleaned.slice(0, 2).concat({ text: '🪔' });
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
  const picked = r0 || c1 || c2 || c3 || '';
  const pickedFrom = r0 ? 'rephrase' : c1 ? 'content' : c2 ? 'assistantText' : c3 ? 'text' : 'none';

  if (!enable) {
    return {
      content: picked,
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
        outLen: picked.length,
        outHead: head(picked),
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
      extra?.userCode ??
      extra?.meta?.userCode ??
      extra?.extra?.userCode ??
      extra?.orch?.userCode ??
      null;

    const evUserText =
      extra?.userText ??
      extra?.meta?.userText ??
      extra?.extra?.userText ??
      extra?.orch?.userText ??
      null;

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

// renderGateway.ts（あなたが貼った try { ... } 内）
// logConvEvidence() の直前に追加して、ctx を補強する

const rawCtx = evCtx as any;

// memoryState / situationSummary が extra のどこに居ても拾えるようにする（推測じゃなく「保険」）
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

// evidenceLog.ts が見るキー名は shortSummary（ここを確実に満たす）
const derivedShortSummary =
  (typeof situationSummaryText === 'string' && situationSummaryText.trim()) ||
  (typeof summaryText === 'string' && summaryText.trim()) ||
  '';

const evCtxFixed = {
  // ctxPack が null の可能性もあるので、最低限オブジェクト化
  ...(rawCtx && typeof rawCtx === 'object' ? rawCtx : {}),
  shortSummary:
    (rawCtx?.shortSummary && String(rawCtx.shortSummary).trim()) ? rawCtx.shortSummary : derivedShortSummary || null,
};

logConvEvidence({
  conversationId: evConversationId,
  userCode: evUserCode,
  userText: typeof evUserText === 'string' ? evUserText : null,
  signals: evSignals,
  ctx: evCtxFixed, // ← ここだけ差し替え
  branch: evBranch,
  slots: evSlots,
  meta: evMeta,
});


    logConvEvidence({
      conversationId: evConversationId,
      userCode: evUserCode,
      userText: typeof evUserText === 'string' ? evUserText : null,
      signals: evSignals,
      ctx: evCtx,
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

    const isScaffoldLike =
      slotPlanPolicy === 'SCAFFOLD' ||
      (slotPlanPolicy == null && hasAnySlots && !picked); // policy不明のときの保険

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

  // ✅ expand は “水増し生成” をしない（行数が少ないままでも良い）
  // - 末尾 🪔 だけ統一
  const expandAllowed = EXPAND_ENABLED && !isSilence && !isIR;

  // 現状 expandAllowed による分岐は“追加生成”がないので同一動作でOK（将来拡張用）
  ensureEndSymbol(blocks, maxLinesFinal);


  let content = renderV2({
    blocks,
    maxLines: maxLinesFinal,
    fallbackText,
    allowUnder5: shortException,
  });

  // ✅ 🪔直前の「空行が増える」事故を潰す（\n\n\n🪔 → \n🪔）
  content = content.replace(/\n{2,}(?=🪔\s*$)/g, '\n');

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
