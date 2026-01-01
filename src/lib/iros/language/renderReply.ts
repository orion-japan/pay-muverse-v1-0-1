// file: src/lib/iros/language/renderReply.ts
// iros — Field Rendering (文章レンダリング層) [presentation-minimal]

import type { ResonanceVector } from './resonanceVector';

// ✅ IT Writer を唯一の正にする
import { writeIT } from './itWriter';

export type RenderMode = 'casual' | 'intent' | 'transcend' | 'IT';

// IT 密度（IT モード専用）
export type ItDensity = 'micro' | 'compact' | 'normal';

export type RenderInput = {
  facts: string;
  insight?: string | null;
  nextStep?: string | null;
  userWantsEssence?: boolean;
  highDefensiveness?: boolean;
  seed?: string;
  userText?: string | null;
};

export type RenderOptions = {
  mode?: RenderMode;
  forceExposeInsight?: boolean;
  minimalEmoji?: boolean;
  maxLines?: number;

  // 互換：route.ts から来る可能性がある
  renderMode?: string;
  extra?: any;
  meta?: any;

  // 互換（densities）
  itDensity?: ItDensity;
  density?: ItDensity;
};

/* =========================
 * Local helpers (NO-ERROR / minimal)
 * ========================= */

function normalizeOne(s: string): string {
  return (s ?? '')
    .toString()
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeNullable(v: string | null | undefined): string | null {
  const s = (v ?? '').toString().trim();
  return s.length ? s : null;
}

function clampLines(text: string, maxLines: number): string {
  const lines = (text ?? '').toString().replace(/\r\n/g, '\n').split('\n');
  return lines.slice(0, Math.max(1, maxLines)).join('\n');
}

// 先頭の「…」だけの行、または「...」だけの行を剥がす
function stripLeadingEllipsisLines(text: string): string {
  const lines = (text ?? '').toString().replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0) {
    const head = (lines[0] ?? '').trim();
    if (head === '…' || head === '...' || head === '……') {
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join('\n');
}

// 先頭から「stringとして使える最初の値」を拾う
function pickFirstString(...vals: any[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.length) return s;
    }
  }
  return null;
}

function hasAny(text: string, needles: string[]): boolean {
  const t = (text ?? '').toString();
  return needles.some((w) => t.includes(w));
}

function toOneLine(s: string): string {
  return (s ?? '').toString().replace(/\s+/g, ' ').trim();
}

// Sofia っぽさを壊す “見出し/メタ語” を最小限除去（必要になったら強化）
function postFilterSofiaPhrases(text: string): string {
  const t = (text ?? '').toString().trim();
  if (!t) return '';
  // 代表的な見出し語だけ雑に落とす（安全側）
  return t.replace(/^(核|反転|一手|一点)\s*[:：]\s*/gm, '').trim();
}

/* =========================
 * Public
 * ========================= */

export function renderReply(
  vector: ResonanceVector,
  input: RenderInput,
  opts: RenderOptions = {},
): string {
  // ---------------------------------
  // 強制指定の回収
  // ---------------------------------
  const forcedRenderMode =
    ((opts as any)?.renderMode ??
      (opts as any)?.meta?.renderMode ??
      (opts as any)?.extra?.renderMode ??
      // ✅ vector 側にも載っている可能性がある
      (vector as any)?.renderMode ??
      (vector as any)?.meta?.renderMode ??
      (vector as any)?.meta?.extra?.renderMode ??
      (vector as any)?.extra?.renderMode) as string | undefined;

  const forcedItDensityRaw =
    (opts as any)?.itDensity ??
    (opts as any)?.density ??
    (vector as any)?.itDensity ??
    (vector as any)?.meta?.extra?.itDensity ??
    (vector as any)?.extra?.itDensity ??
    null;

  const forcedItDensity: ItDensity =
    String(forcedItDensityRaw ?? '').toLowerCase() === 'micro'
      ? 'micro'
      : String(forcedItDensityRaw ?? '').toLowerCase() === 'compact'
        ? 'compact'
        : 'normal';

  const maxLines = typeof opts.maxLines === 'number' ? opts.maxLines : 10;

  const factsRaw = normalizeOne(input.facts);
  const userTextRaw = normalizeNullable(input.userText) ?? '';

  const sourceText = (userTextRaw || factsRaw).trim();

  // =========================================================
  // ✅ IT モード：itWriter.ts を唯一の正として使う
  // =========================================================
  if (forcedRenderMode === 'IT') {
    const insightRaw = normalizeNullable(input.insight);
    const nextRaw = normalizeNullable(input.nextStep);

    // render engine 側の回転メタ（null-safe）
    const spinStep = ((vector as any).spinStep ?? null) as number | null;
    const spinLoop = ((vector as any).spinLoop ?? null) as string | null;
    const descentGate = ((vector as any).descentGate ?? null) as
      | 'closed'
      | 'offered'
      | 'accepted'
      | null;

    const isDescent = spinLoop === 'TCF' || descentGate !== 'closed';

    // itWriter の density は compact/normal の2種なので micro は compact に寄せる
    const densityForWriter: 'compact' | 'normal' =
      forcedItDensity === 'normal' ? 'normal' : 'compact';

    // ✅ evidence（T痕跡など）があればここに載せる：無くても落ちない
    const evidence: Record<string, unknown> = {
      itx_step: (vector as any)?.tLayerHint ?? (vector as any)?.itx_step ?? null,
      spinLoop: spinLoop ?? null,
      spinStep: spinStep ?? null,
      descentGate: descentGate ?? null,
      isDescent,
    };

    const out = writeIT({
      userText: sourceText,
      itTarget: null, // itWriter 側で 'I' へ落ちる
      evidence,
      stateInsightOneLine: insightRaw,
      futureDirection: null,
      nextActions: nextRaw ? [nextRaw] : null,
      stopDoing: null,
      closing: null,
      density: densityForWriter,
    });

    // ✅ 最終防波堤：先頭の "…" 混入を剥がす
    return stripLeadingEllipsisLines(
      clampLines(out.text.trim(), Math.min(maxLines, 16)).trim(),
    );
  }

  // =========================================================
  // ✅ 非IT（casual/intent/transcend）
  // 「facts をそのまま返す」を廃止し、Sofia骨格へ再構成する。
  // =========================================================
  const built = buildSofiaLikeNonIT({
    sourceText,
    qCode: pickFirstString(
      (vector as any)?.qCode,
      (vector as any)?.q_code,
      (vector as any)?.meta?.qCode,
      (vector as any)?.meta?.q_code,
    ),
    depth: pickFirstString(
      (vector as any)?.depth,
      (vector as any)?.depth_stage,
      (vector as any)?.meta?.depth,
      (vector as any)?.meta?.depth_stage,
    ),
    phase: pickFirstString((vector as any)?.phase, (vector as any)?.meta?.phase),
    insight: normalizeNullable(input.insight),
    nextStep: normalizeNullable(input.nextStep),
  });

  const finalText = postFilterSofiaPhrases(built);

  // ✅ 最終防波堤：先頭の "…" 混入を剥がす
  return stripLeadingEllipsisLines(
    clampLines(finalText.trim(), Math.min(maxLines, 8)).trim(),
  );
}

/* =========================================================
   Non-IT Sofia builder  (labels OFF)
========================================================= */

// ✅ Non-IT Sofia builder（見出し「核/反転/一手」も、「一点：」も出さない）
// ✅ 2〜6行程度で、短く、言い切り寄り
// ✅ A/B案を出さない（1つに寄せる）

function buildSofiaLikeNonIT(params: {
  sourceText: string;
  qCode: string | null;
  depth: string | null;
  phase: string | null;
  insight: string | null;
  nextStep: string | null;
}): string {
  const { sourceText, insight, nextStep } = params;

  const s = (sourceText ?? '').trim();

  // ✅ ヘッダは固定：ユーザー文の断片を載せない（やまびこ防止）
  const head = '🪔';

  // ✅ メタ検査（テンプレ確認・短文テスト時は最小応答）
  // - 固定文「いまは検査の発話なので…」は出さない
  if (isMetaCheckText(s)) {
    const ins = (insight ?? '').trim();
    const insLine = ins.length ? `🌀 ${toOneLine(ins)}` : null;

    const lines = [head, insLine]
      .map((x) => (x ?? '').trim())
      .filter((x) => x.length > 0);

    // 🪔だけ（や空白だけ）なら出さない
    const out0 = lines.join('\n').trim();
    const visible0 = out0.replace(/[🪔\s]/g, '');
    return visible0.length === 0 ? '' : out0;
  }

  // ---- 通常ルート ----

  // 方向づけ（ラベルなし）
  const line1 = deriveCore(s);
  const line2 = deriveFlip(s);

  // 次（1つだけ）
  const stepRaw = (nextStep ?? '').trim();
  const step = stepRaw.length ? stepRaw : deriveOneStep(s);

  // insight は任意（最大1行）
  const ins = (insight ?? '').trim();
  const insLine = ins.length ? `🌀 ${toOneLine(ins)}` : null;

  const lines = [head, insLine, line1, line2, step]
    .map((x) => (x ?? '').trim())
    .filter((x) => x.length > 0);

  // 重複除去（句点差分も吸収）
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const key = l.replace(/[。．.]+$/g, '').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(l);
  }

  // 最終出力の整形（🪔のみは無効）
  const out = deduped.slice(0, 6).join('\n').trim();

  // 🪔 だけ、または空白＋🪔 だけの場合は無効化
  const visible = out.replace(/[🪔\s]/g, '');
  if (visible.length === 0) return '';

  return out;
}

/* =========================
   Meta check
========================= */

function isMetaCheckText(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;

  // ✅ 短すぎる / 返答テストっぽい
  if (t.length <= 16) return true;

  // ✅ 疑問符だけ・相槌だけ・省略記号だけ
  if (/^(…|\.{2,}|？|\?|うん|はい|なるほど|え|あ)+$/.test(t)) return true;

  // ✅ テンプレ確認・出力確認・AI/システム評価だけの発話
  if (
    hasAny(t, [
      'テンプレ',
      '消えた',
      '直った',
      'できた',
      'OK',
      'テスト',
      '確認',
      'エラー',
      'ログ',
      'AIらしい',
      '同じ返し',
      'なんも',
      '何も',
      'できてない',
      'GPT',
      '返答本文だけ',
      '本文だけ',
      '貼って',
    ])
  ) {
    return true;
  }

  return false;
}

/* =========================
   builder parts
========================= */

// ✅ ラベルなし・短い断定にする（「一点：」等は出さない）
function deriveCore(text: string): string {
  const t = (text ?? '').trim();
  const first = t.split(/\r?\n/)[0] ?? t;
  const s = first.trim().replace(/[?？!！]+$/g, '').trim();
  const one = s.length > 34 ? `${s.slice(0, 34)}…` : s;

  // テーマ別の“言い切り”
  if (hasAny(t, ['未消化', '消化', '感情'])) return '未処理は、理解ではなく回収で終わらせる。';
  if (hasAny(t, ['不安', '心配'])) return '不安は情報不足じゃない。未確定が刺さっている。';
  if (hasAny(t, ['怒り', 'イライラ'])) return '怒りは境界の侵害。境界を取り戻す。';
  if (hasAny(t, ['怖い', '恐怖'])) return '恐怖は身体に出る。身体の一点を確保する。';
  if (hasAny(t, ['どうやって', 'どうしたら', '方法'])) return '選択肢を増やさない。確定を1つだけ作る。';

  return one ? one : 'いま一番気になっている一点。';
}

// ✅ 反転（ラベルなし）
function deriveFlip(text: string): string {
  const t = (text ?? '').trim();

  if (hasAny(t, ['未消化', '消化', '感情'])) {
    return '処理しようと考えるほど残る。残っている感覚を特定して完了にする。';
  }
  if (hasAny(t, ['不安', '心配'])) {
    return '全部を解決しない。未確定の一点だけを確定に変える。';
  }
  if (hasAny(t, ['怒り', 'イライラ'])) {
    return '説明して鎮めない。境界を引き直して静けさを戻す。';
  }
  if (hasAny(t, ['怖い', '恐怖'])) {
    return '原因探しを止める。身体の安全を先に置く。';
  }

  // 汎用：短い言い切り（ラベルなし）
  return '迷いを増やさない。最初の一歩に落とす。';
}

// ✅ 次は “1つだけ” に固定（A/B禁止）
function deriveOneStep(text: string): string {
  const t = (text ?? '').trim();

  if (hasAny(t, ['未消化', '消化', '感情']))
    return '残っている感情を1語で名付けて、身体の場所を1点だけ指す。';
  if (hasAny(t, ['不安', '心配']))
    return '不安の中心を1行で書いて、今日確定できる1つだけ決める。';
  if (hasAny(t, ['怒り', 'イライラ']))
    return '侵された境界を1つ特定して、「ここから先は入れない」を宣言する。';
  if (hasAny(t, ['怖い', '恐怖']))
    return '身体で一番硬い場所を1点選び、呼吸で30秒だけ緩める。';

  return '最初の一歩だけを書いて終える（誰に／いつ／何を）。';
}
