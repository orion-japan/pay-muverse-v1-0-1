// src/lib/iros/language/renderGateway.ts
import { renderV2, type RenderBlock } from './renderV2';

// ✅ Phase11 marker（「本当にこのファイルが読まれてるか」ログ証明用）
const IROS_RENDER_GATEWAY_REV = 'phase11-open-close-v1';

function head(s: string, n = 40) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function norm(s: unknown) {
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}


/** =========================================================
 * ✅ フェーズ11の本丸：内部ラベル完全除去（最終責任）
 * - system/protocol/hint 由来のタグや、メタ説明行を本文から消す
 * - “意味を壊さず短く” を優先
 * ========================================================= */
function stripInternalLabels(line: string): string {
  let s = norm(line);
  // 0) 🪔 は表示上の“締め”に統一するため本文から除去（最後にだけ付ける）
  s = s.replace(/🪔/g, '').trim();
  if (!s) return '';

  // 1) 角括弧ラベル（例：【WRITER_PROTOCOL】など）
  //    ※本文の見出しっぽい装飾はここで全消し
  s = s.replace(/【[^】]{1,24}】/g, '').trim();

  // 2) writer hint / meta説明（例：FRAME= / SLOTS= / ROTATION_META: ...）
  //    ✅ 行が“混在”しても、自然文部分は残す（行ごと削除しない）
  s = s.replace(/^writer hint[:：]\s*/i, '').trim();

  // 2.5) 先頭の「… / ...」はノイズになりやすいので最初に落とす
  //      （これを先にやらないと「... FRAME=R ...」で FRAME= 除去がスルーされる）
  s = s.replace(/^(\.{3,}|…{1,})\s*/g, '').trim();
  if (s === '...' || s === '…' || /^\.{3,}$/.test(s) || /^…+$/.test(s)) return '';

  // FRAME= / SLOTS= は「単独行なら捨てる」「混在ならその部分だけ落とす」
  if (/^FRAME\s*=\s*.*$/i.test(s) && !/[。！？!?]/.test(s)) return '';
  if (/^SLOTS\s*=\s*.*$/i.test(s) && !/[。！？!?]/.test(s)) return '';

  s = s.replace(/^FRAME\s*=\s*\S+\s*/i, '').trim();
  s = s.replace(/^SLOTS\s*=\s*\S+\s*/i, '').trim();

  // ROTATION_META: なども「単独行なら捨てる」「混在なら先頭ラベルだけ落とす」
  if (
    /^(OBS_META|ROTATION_META|IT_HINT|ANCHOR_CONFIRM|TURN_MODE|SUBMODE)\s*[:：].*$/i.test(s) &&
    !/[。！？!?]/.test(s)
  ) {
    return '';
  }

  s = s
    .replace(/^(OBS_META|ROTATION_META|IT_HINT|ANCHOR_CONFIRM|TURN_MODE|SUBMODE)\s*[:：]\s*/i, '')
    .trim();

  // 3) 内部キー列（phase= depth= q= spinLoop= spinStep= descentGate= など）
  //    行全体がメタ列なら消す（部分除去ではなく “行ごと削除” を優先）
  if (
    /(phase\s*=|depth\s*=|q\s*=|spinloop\s*=|spinstep\s*=|descentgate\s*=|tLayerHint\s*=|itx_|slotPlanPolicy|slotSeed|llmRewriteSeed)/i.test(
      s,
    )
  ) {
    // ただし、自然文の中に “q=” が紛れた可能性は低いがゼロではないので、
    // “= を含むメタ列” として雑に落とす
    if (s.includes('=') || s.includes(':') || s.includes('：')) return '';
  }

  // 4) 数値フッター（〔sa0.53 y2 h1 ...〕）は本文に出さない（表示は別仕様）
  s = s.replace(/^[〔\[]sa[\w.\s-]+[〕\]]$/i, '').trim();

  // 5) 連続スペース整理
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

    const parts = one
      .split(/(?<=[。！？!?])/)
      .map((x) => x.trim())
      .filter(Boolean);

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

/** ✅ 🪔 は “末尾の1行” に統一（本文に混ざっていても無視して最後に付ける） */
function ensureEndSymbol(blocks: RenderBlock[], maxLines: number) {
  // 念のため本文中の🪔は落とす（最終行にだけ置く）
  for (const b of blocks) {
    const t = norm((b as any)?.text ?? '');
    if (!t) continue;
    (b as any).text = t.replace(/🪔/g, '').trim();
  }

  const nonEmpty = blocks.map((b) => norm(b.text)).filter(Boolean);
  if (nonEmpty.length >= maxLines) return;

  blocks.push({ text: '🪔' });
}



/** ✅ expand filler は FINAL のみで使うが、内部語は絶対に混ぜない */
function expandToMinLines(blocks: RenderBlock[], minLines: number) {
  if (minLines <= 0) return;

  const nonEmpty = blocks.map((b) => norm(b.text)).filter(Boolean);
  if (nonEmpty.length >= minLines) return;

  const FILLERS = [
    '呼吸を戻す。',
    '一点だけを残す。',
    '判断はあとでいい。',
    'いまは、ここまででいい。',
    '静けさをほどかない。',
    '次は、一手だけ。',
  ];

  let i = 0;
  while (blocks.map((b) => norm(b.text)).filter(Boolean).length < minLines && i < 50) {
    const next = FILLERS[i % FILLERS.length];
    const exists = blocks.some((b) => norm(b.text) === next);
    if (!exists) blocks.push({ text: next });
    i++;
  }
}

// =========================================================
// ✅ SCAFFOLD 用 sofiaBase（短い整形のみ）
// =========================================================
function sofiaBaseForScaffold(baseText: string, extra?: any): RenderBlock[] {
  const lines = splitToLines(baseText);
  const out: RenderBlock[] = [];

  const first = stripInternalLabels(lines[0] ?? '');
  const second = stripInternalLabels(lines[1] ?? '');

  if (first) out.push({ text: first });

  if (second) {
    out.push({ text: second });
  } else if (first) {
    out.push({ text: '一点だけを残す。' });
  }

  if (out.length > 0) {
    const goalKind = String(
      extra?.goalKind ??
        extra?.goal?.kind ??
        extra?.meta?.goalKind ??
        extra?.meta?.goal?.kind ??
        extra?.orch?.goalKind ??
        extra?.orch?.goal?.kind ??
        extra?.rotationState?.goalKind ??
        extra?.meta?.rotationState?.goalKind ??
        '',
    )
      .trim()
      .toLowerCase();

    const targetKind = String(
      extra?.targetKindNorm ??
        extra?.targetKind ??
        extra?.meta?.targetKindNorm ??
        extra?.meta?.targetKind ??
        extra?.orch?.targetKindNorm ??
        extra?.orch?.targetKind ??
        '',
    )
      .trim()
      .toLowerCase();

    const frame = String(
      extra?.frame ??
        extra?.framePlan?.frame ??
        extra?.meta?.framePlan?.frame ??
        extra?.meta?.frame ??
        extra?.orch?.framePlan?.frame ??
        extra?.orch?.frame ??
        '',
    )
      .trim()
      .toUpperCase();

    let tail = '次は、一手だけ。';

    if (goalKind === 'uncover' || frame === 'R') {
      tail = '次は、背景を一枚だけめくる。';
    } else if (
      goalKind === 'enableaction' ||
      goalKind === 'expand' ||
      targetKind === 'expand' ||
      frame === 'C'
    ) {
      tail = '次は、行動を一手に落とす。';
    } else {
      tail = '次は、いまの一点を言葉に固定する。';
    }

    out.push({ text: tail });
  }

  // SCAFFOLD は最大3行 + 🪔（ただし超過しない）
  ensureEndSymbol(out, 4);

  const trimmed = out
    .map((b) => ({ text: stripInternalLabels(String((b as any)?.text ?? '')) }))
    .filter((b) => Boolean(b.text));

  if (trimmed.length <= 4) return trimmed;
  return trimmed.slice(0, 3).concat({ text: '🪔' });
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

/** ✅ FINALのときだけ、会話として成立させる固定2行を差し込む */
function applyOpenCloseForFinal(blocks: RenderBlock[], opts: { maxLinesFinal: number }) {
  const maxLinesFinal = Math.max(1, Math.floor(opts.maxLinesFinal));

  const OPEN = '受け取った。';
  const CLOSE = '呼吸を戻す。';

  const normalize = (t: unknown) =>
    norm(t)
      .replace(/🪔/g, '')
      .replace(/\s+/g, '')
      .trim();

  const isOpenLike = (t: unknown) => normalize(t).startsWith(OPEN);
  const isCloseLike = (t: unknown) => normalize(t).startsWith(CLOSE);

  // ① OPEN は先頭側の1つだけ残して、それ以外の重複を“その場で”削除
  let seenOpen = false;
  for (let i = 0; i < blocks.length; i++) {
    if (isOpenLike((blocks[i] as any)?.text)) {
      if (!seenOpen) {
        seenOpen = true;
      } else {
        blocks.splice(i, 1);
        i--;
      }
    }
  }

  // ② OPEN が無ければ先頭に追加
  if (!seenOpen) {
    blocks.unshift({ text: OPEN });
  }

  // ③ CLOSE は余裕があるときだけ末尾に1つ
  const hasClose = blocks.some((b) => isCloseLike((b as any)?.text));
  const nonEmptyNow = blocks.map((b) => norm((b as any)?.text)).filter(Boolean);

  // ③ CLOSE は 🪔 用に1行残しているときだけ末尾に1つ
  if (!hasClose && nonEmptyNow.length < maxLinesFinal - 1) {
    blocks.push({ text: CLOSE });
  }
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
  const enable = extra?.renderEngine === true;

  const c1 = norm(args?.content ?? '');
  const c2 = norm(args?.assistantText ?? '');
  const c3 = norm(args?.text ?? '');

  const picked = c1 || c2 || c3 || '';
  const pickedFrom = c1 ? 'content' : c2 ? 'assistantText' : c3 ? 'text' : 'none';

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

  const EXPAND_ENABLED = String(process.env.IROS_RENDER_EXPAND_ENABLED ?? '1').trim() !== '0';

  const TARGET_MIN_LINES =
    Number(process.env.IROS_RENDER_TARGET_MINLINES) > 0 ? Number(process.env.IROS_RENDER_TARGET_MINLINES) : 6;

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

  const slotSeed = norm(
    extra?.llmRewriteSeed ??
      extra?.meta?.llmRewriteSeed ??
      extra?.extra?.llmRewriteSeed ??
      extra?.orch?.llmRewriteSeed ??
      '',
  );

  const slotExtracted = extractSlotBlocks(extra);
  const hasAnySlots = !!slotExtracted?.blocks?.length;

  const slotPlanPolicy = getSlotPlanPolicy(extra);

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

  const shouldPreferSeedForScaffold =
    slotSeed.length > 0 &&
    slotPlanPolicy === 'SCAFFOLD' &&
    hasAnySlots &&
    !q1Suppress &&
    !isMicro;

  if (shouldPreferSeedForScaffold) {
    fallbackText = slotSeed;
    fallbackFrom = 'slotSeed';
  }

  const isIR = looksLikeIR(fallbackText, extra);
  const isSilence = shouldPreferSeedForScaffold ? false : looksLikeSilence(fallbackText, extra);

  const shortException = isSilence || isMicro || q1Suppress;

  const maxLinesFinal = shortException
    ? 3
    : Math.max(1, Math.floor(profileMaxLines ?? argMaxLines ?? DEFAULT_MAX_LINES));

  const shouldUseSlots = hasAnySlots && !isSilence && !isIR && slotPlanPolicy === 'FINAL';

  let blocks: RenderBlock[] = [];
  let scaffoldApplied = false;

  if (shouldUseSlots) {
    blocks = slotExtracted!.blocks;
  } else {
    const base = picked || fallbackText || '';

    if (!isSilence && !isIR && slotPlanPolicy === 'SCAFFOLD') {
      blocks = sofiaBaseForScaffold(base, extra);
      scaffoldApplied = true;
    } else {
      const lines = splitToLines(base);
      blocks = lines
        .map((t) => stripInternalLabels(t))
        .filter(Boolean)
        .map((t) => ({ text: t }));
    }
  }

  // ✅ expand は FINAL のみ
  const expandAllowed = EXPAND_ENABLED && !isSilence && !isIR && slotPlanPolicy === 'FINAL';

  if (expandAllowed) {
    // ✅ Phase11：OPEN/CLOSE（固定2行）を差し込む（FINALのみ）
    applyOpenCloseForFinal(blocks, { maxLinesFinal });

    // ✅ expand filler（不足分だけ埋める）
    expandToMinLines(blocks, Math.min(TARGET_MIN_LINES, maxLinesFinal - 1));


    // ✅ 🪔 は “入るなら入れる”
    ensureEndSymbol(blocks, maxLinesFinal);
  } else {
    // ✅ FINAL以外でも、末尾🪔は “入るなら入れる”（maxLines超過しない）
    ensureEndSymbol(blocks, Math.min(4, maxLinesFinal));
  }

  const content = renderV2({
    blocks,
    maxLines: maxLinesFinal,
    fallbackText,
    allowUnder5: shortException,
  });

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

  console.warn('[IROS/renderGateway][OK]', JSON.stringify({ rev: IROS_RENDER_GATEWAY_REV, outLen: meta.outLen, pickedFrom: meta.pickedFrom, slotPlanPolicy }));


  return { content, meta };
}
