// file: src/lib/iros/server/handleIrosReply.postprocess.ts
// iros - Postprocess (minimal first + meta safety + rotationState single source)

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IrosStyle } from '@/lib/iros/system';
import { isMetaAnchorText } from '@/lib/iros/intentAnchor';

// ★ 追加：MemoryRecall から pastStateNote を作る
import { preparePastStateNoteForTurn } from '@/lib/iros/memoryRecall';

// ★★★ 追加：文章レンダリング層（IT時だけ差し替え）
import { renderReply } from '@/lib/iros/language/renderReply';
import { buildResonanceVector } from '@/lib/iros/language/resonanceVector';

export type PostProcessReplyArgs = {
  supabase: SupabaseClient;
  userCode: string;
  conversationId: string;
  userText: string;

  effectiveStyle: IrosStyle | string | null;
  requestedMode: string | undefined;

  orchResult: any;

  /** ✅ 追加（任意）：履歴が来るなら将来ここでも使える */
  history?: unknown[];

  /** ✅ 追加（任意）：topicLabel を明示できる */
  topicLabel?: string | null;

  /** ✅ 追加（任意）：limit を外から調整 */
  pastStateLimit?: number;

  /** ✅ 追加（任意）：常に recent_topic fallback するか */
  forceRecentTopicFallback?: boolean;
};

export type PostProcessReplyOutput = {
  assistantText: string;
  metaForSave: any;
};

// ✅ 追加：jsonb(q_counts) を安全に扱う
function normalizeJsonObject(v: unknown): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return v as Record<string, any>;
}

function toInt0to9(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return Math.max(0, Math.min(9, n));
}

function toNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

// ✅ NEW: q_counts を最低限の形で正規化
type QCounts = {
  it_cooldown?: number; // 0 or 1 を想定（将来拡張OK）
};

function normalizeQCounts(v: unknown): QCounts {
  if (!v || typeof v !== 'object') return { it_cooldown: 0 };
  const obj = v as any;
  const cd = typeof obj.it_cooldown === 'number' ? obj.it_cooldown : 0;
  return { it_cooldown: Math.max(0, Math.min(3, Math.round(cd))) };
}


function extractAssistantText(orchResult: any): string {
  if (orchResult && typeof orchResult === 'object') {
    const r: any = orchResult;
    const c = toNonEmptyString(r.content);
    if (c) return c;
    const t = toNonEmptyString(r.text);
    if (t) return t;

    // JSON stringify fallback（循環参照は避ける）
    try {
      return JSON.stringify(r);
    } catch {
      return String(r);
    }
  }
  return String(orchResult ?? '');
}

function pickIntentAnchorText(meta: any): string {
  const a = meta?.intentAnchor;
  const t = (a?.anchor_text ?? '') || (a?.anchorText ?? '') || (a?.text ?? '') || '';
  return String(t);
}

/**
 * ✅ intentAnchor 汚染防止
 * - LLMや途中処理が “状況文/メタ/開発会話” を intentAnchor に入れても落とす
 * - DB由来っぽい Row（id/user_id/created_at 等）なら温存しやすくする
 */
function sanitizeIntentAnchor(meta: any): any {
  if (!meta || typeof meta !== 'object') return meta;
  if (!meta.intentAnchor) return meta;

  const text = pickIntentAnchorText(meta);
  const hasText = Boolean(text && text.trim());

  const a = meta.intentAnchor;
  const looksLikeRow =
    Boolean(a?.id) || Boolean(a?.user_id) || Boolean(a?.created_at) || Boolean(a?.updated_at);

  // 1) テキストが無い → 捨てる
  if (!hasText) {
    delete meta.intentAnchor;
    return meta;
  }

  // 2) intentAnchor の内容がメタ判定に引っかかる → 捨てる
  if (isMetaAnchorText(text)) {
    delete meta.intentAnchor;
    return meta;
  }

  // 3) Rowでもなく、イベント(set/reset)でもない → 擬似アンカーとして捨てる
  const ev: string | null =
    meta.anchorEventType ??
    meta.intentAnchorEventType ??
    meta.anchor_event_type ??
    meta.intent_anchor_event_type ??
    null;

  const shouldBeRealEvent = ev === 'set' || ev === 'reset';

  if (!looksLikeRow && !shouldBeRealEvent) {
    delete meta.intentAnchor;
    return meta;
  }

  return meta;
}

/* =========================================================
   RotationState single source (postprocess side)
   - ここで metaForSave.rotationState を必ず「正規形」に揃える
   - render / persist は rotationState だけを見る前提に寄せる
========================================================= */

type DescentGate = 'closed' | 'offered' | 'accepted';
type SpinLoop = 'SRI' | 'TCF';

function normalizeDescentGate(v: any): DescentGate {
  if (v == null) return 'closed';

  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'closed' || s === 'offered' || s === 'accepted') return s as DescentGate;
    return 'closed';
  }

  // 互換：boolean のとき（旧）
  if (typeof v === 'boolean') return v ? 'accepted' : 'closed';

  return 'closed';
}

function normalizeSpinLoop(v: any): SpinLoop | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (s === 'SRI' || s === 'TCF') return s as SpinLoop;
  return null;
}

function normalizeDepth(v: any): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

function ensureRotationState(meta: any, orchResult: any): any {
  const m: any = meta && typeof meta === 'object' ? meta : {};

  // orchResult 由来の rotation 候補も拾う（metaに入ってない場合の取りこぼし防止）
  const or: any = orchResult && typeof orchResult === 'object' ? orchResult : null;

  // ✅ extra 由来（UIボタン等の override）
  const ex: any = m.extra && typeof m.extra === 'object' ? m.extra : {};

  const rot =
    m.rotation ??
    m.rotationState ??
    m.spin ??
    (m.will && (m.will.rotation ?? m.will.spin)) ??
    (or &&
      (or.rotation ??
        or.rotationState ??
        or.spin ??
        (or.will && (or.will.rotation ?? or.will.spin)))) ??
    null;

  // ---------------------------------------------------------
  // ✅ 優先順位：extra → rot → meta
  // （ボタンなどで明示した値を「確実に勝たせる」）
  // ---------------------------------------------------------
  const spinLoop =
    normalizeSpinLoop(ex?.spinLoop ?? ex?.spin_loop) ??
    normalizeSpinLoop(rot?.spinLoop ?? rot?.loop) ??
    normalizeSpinLoop(m.spinLoop) ??
    null;

  const descentGate = normalizeDescentGate(
    ex?.descentGate ?? ex?.descent_gate ?? rot?.descentGate ?? m.descentGate,
  );

  const depth =
    normalizeDepth(ex?.depth ?? ex?.nextDepth ?? ex?.next_depth) ??
    normalizeDepth(rot?.nextDepth ?? rot?.depth) ??
    normalizeDepth(m.depth) ??
    null;

  // ✅ renderMode も extra を本体に同期（ログの “renderMode: undefined” を消す）
  const rm = ex?.renderMode ?? ex?.render_mode;
  if (rm != null && m.renderMode == null && m.render_mode == null) {
    m.renderMode = rm;
  }

  // ここで “唯一の正規形” に揃える
  m.spinLoop = spinLoop;
  m.descentGate = descentGate;
  m.depth = depth;

  m.rotationState = {
    spinLoop,
    descentGate,
    depth,
    reason: rot?.reason ?? undefined,
  };

  return m;
}

/* =========================================================
   pastStateNote injection guards (single source)
   - 相談の芯を最優先：必要な時だけ注入する
========================================================= */

function normalizeText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : String(v ?? '').trim();
}

function isRecallOrGoalLike(textRaw: string): boolean {
  const t = normalizeText(textRaw);
  if (!t) return false;

  // 最小の検出（デモ仕上げ用）：goal/recall 系の割り込み判定
  // ※この判定は「注入禁止」に使う（注入トリガーではない）
  return (
    t.includes('目標') ||
    t.includes('ゴール') ||
    t.includes('覚えて') ||
    t.includes('覚えてる') ||
    t.includes('思い出') ||
    t.includes('前の話') ||
    t.includes('さっきの') ||
    t.includes('先週') ||
    t.includes('達成') ||
    t.toLowerCase().includes('recall')
  );
}

function isExplicitRecallRequest(textRaw: string): boolean {
  const t = normalizeText(textRaw);
  if (!t) return false;

  // 明示的に「思い出して」「前の話」などを要求している場合だけ true
  return (
    t.includes('思い出して') ||
    t.includes('前の話') ||
    t.includes('前回') ||
    t.includes('さっきの話') ||
    t.includes('先週の') ||
    t.toLowerCase().includes('recall')
  );
}

function getStreakLength(meta: any): number {
  const v =
    meta?.qTrace?.streakLength ??
    meta?.qTraceUpdated?.streakLength ??
    meta?.uncoverStreak ??
    0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function shouldSkipPastStateNote(args: PostProcessReplyArgs, metaForSave: any): boolean {
  const requestedMode = (args.requestedMode ?? metaForSave?.mode ?? '').toString().toLowerCase();
  const userText = normalizeText(args.userText);

  // 明示 recall だけは「相談継続中」でも注入を許可する（ただし他の強制OFF条件は優先）
  const explicitRecall = isExplicitRecallRequest(userText);

  // 1) メタで明示的に禁止
  if (metaForSave?.skipMemory === true) return true;
  if (metaForSave?.goalRecallOnly === true) return true;
  if (metaForSave?.achievementSummaryOnly === true) return true;

  // 2) recall モード中は注入しない（recall 自体が別ルート）
  if (requestedMode === 'recall') return true;

  // 3) goal系は注入しない（割り込み/混線防止）
  //    recall系は “明示 recall” のときだけ許可する
  const recallOrGoal = isRecallOrGoalLike(userText);
  if (recallOrGoal && !explicitRecall) return true;

  // 4) 相談が連続している最中（streak 継続中）は注入しない（芯を守る）
  //    ※ただし「明示 recall」だけは例外
  const streak = getStreakLength(metaForSave);
  if (!explicitRecall && streak > 0) return true;

  return false;
}

/* =========================================================
   IT Render switch (postprocess side)
   - meta.renderMode === 'IT' の時だけ renderReply を通して差し替える
========================================================= */

function isItRenderMode(metaForSave: any): boolean {
  const rm =
    metaForSave?.renderMode ?? metaForSave?.render_mode ?? metaForSave?.extra?.renderMode ?? null;

  return String(rm ?? '').toUpperCase() === 'IT';
}

export async function postProcessReply(args: PostProcessReplyArgs): Promise<PostProcessReplyOutput> {
  const { orchResult, supabase, userCode, userText } = args;

  const assistantText = extractAssistantText(orchResult);
  let finalAssistantText = assistantText;

  // meta は result.meta をベースにする（なければ空オブジェクトで統一）
  const metaRaw =
    orchResult && typeof orchResult === 'object' && (orchResult as any).meta
      ? (orchResult as any).meta
      : null;

  const metaForSave: any = metaRaw && typeof metaRaw === 'object' ? { ...metaRaw } : {};

  // ✅ 最終確定：qTraceUpdated を metaForSave / metaForReply に焼き込む
  const qTraceUpdated: any =
    (orchResult as any)?.qTraceUpdated ?? (metaRaw as any)?.qTraceUpdated ?? null;

  const applyQTraceUpdated = (m: any) => {
    if (!m || !qTraceUpdated || typeof qTraceUpdated !== 'object') return;

    const streak = Number(qTraceUpdated.streakLength ?? 0);
    const streakSafe = Number.isFinite(streak) ? streak : 0;

    m.qTrace = {
      ...(m.qTrace ?? {}),
      ...qTraceUpdated,
      streakLength: streakSafe,
    };

    // uncoverStreak も同期（allow条件がこれを見るなら）
    if (streakSafe > 0) {
      m.uncoverStreak = Math.max(Number(m.uncoverStreak ?? 0), streakSafe);
    }

    // 互換キーも合わせる（返却側が見るため）
    m.qTraceUpdated = {
      ...(m.qTraceUpdated ?? {}),
      ...qTraceUpdated,
      streakLength: streakSafe,
    };
  };

  const metaForReply = metaForSave;

  applyQTraceUpdated(metaForSave);
  applyQTraceUpdated(metaForReply);

  // ✅ “北極星事故” の最後の止血（ここでも落とす）
  sanitizeIntentAnchor(metaForSave);

  // ✅ rotationState を postprocess 時点で一本化しておく（取りこぼし防止）
  try {
    ensureRotationState(metaForSave, orchResult);
  } catch (e) {
    console.warn('[IROS/PostProcess] ensureRotationState failed', e);
  }

  // =========================================================
  // ✅ pastStateNote 注入（必要な時だけ）
  // =========================================================
  metaForSave.extra = metaForSave.extra ?? {};

  const skipInject = shouldSkipPastStateNote(args, metaForSave);
  if (skipInject) {
    // 注入しない場合も、フィールドは明示的に落として混線を防ぐ
    metaForSave.extra.pastStateNoteText = null;
    metaForSave.extra.pastStateTriggerKind = null;
    metaForSave.extra.pastStateKeyword = null;

    console.log('[IROS/PostProcess] pastStateNote skipped', {
      userCode,
      reason: 'guard',
    });
  } else {
    try {
      const topicLabel =
        typeof args.topicLabel === 'string'
          ? args.topicLabel
          : metaForSave?.situation_topic ??
            metaForSave?.situationTopic ??
            metaForSave?.topicLabel ??
            null;

      const limit =
        typeof args.pastStateLimit === 'number' && Number.isFinite(args.pastStateLimit)
          ? args.pastStateLimit
          : 3;

      // ✅ Step B：default false（常時fallbackをやめる）
      // true にするのは：
      // - 引数で明示
      // - topicLabel がある
      // - 明示 recall 要求がある
      const explicitRecall = isExplicitRecallRequest(userText);

      const forceFallback =
        typeof args.forceRecentTopicFallback === 'boolean'
          ? args.forceRecentTopicFallback
          : Boolean(topicLabel) || explicitRecall;

      // ★ memoryRecall 側の引数名が (client) でも (supabase) でも壊れないように両方渡す
      const recall = await preparePastStateNoteForTurn({
        client: supabase,
        supabase,
        userCode,
        userText,
        topicLabel,
        limit,
        forceRecentTopicFallback: forceFallback,
      } as any);

      // hasNote の時だけ入れる（トークン節約）
      if (recall?.hasNote && recall?.pastStateNoteText) {
        metaForSave.extra.pastStateNoteText = recall.pastStateNoteText;
        metaForSave.extra.pastStateTriggerKind = recall.triggerKind ?? null;
        metaForSave.extra.pastStateKeyword = recall.keyword ?? null;
      } else {
        metaForSave.extra.pastStateNoteText = null;
        metaForSave.extra.pastStateTriggerKind = recall?.triggerKind ?? null;
        metaForSave.extra.pastStateKeyword = recall?.keyword ?? null;
      }

      console.log('[IROS/PostProcess] pastStateNote injected', {
        userCode,
        hasNote: Boolean(recall?.hasNote),
        triggerKind: recall?.triggerKind ?? null,
        keyword: recall?.keyword ?? null,
        len: recall?.pastStateNoteText ? recall.pastStateNoteText.length : 0,
        forceFallback,
        topicLabel,
      });
    } catch (e) {
      console.warn('[IROS/PostProcess] pastStateNote inject failed', e);
    }
  }

  // =========================================================
  // ★★★ IT のときだけ renderReply を噛ませて最終表示を差し替える（最小・確実版）
  // =========================================================
  if (isItRenderMode(metaForSave)) {
    try {
      const spinLoop =
        metaForSave?.rotationState?.spinLoop ?? metaForSave?.spinLoop ?? null;

      const descentGate =
        metaForSave?.rotationState?.descentGate ?? metaForSave?.descentGate ?? 'closed';

      const spinStep =
        typeof (metaForSave as any)?.spinStep === 'number' &&
        Number.isFinite((metaForSave as any).spinStep)
          ? (metaForSave as any).spinStep
          : null;

      const framePlan = (metaForSave as any)?.framePlan ?? null;

      const vector = buildResonanceVector({
        meta: metaForSave,
        userText,
      } as any);

      const input = {
        facts: userText,
        insight: null,        // ✅ ここが本質。assistantText を入れない
        nextStep: null,
        userWantsEssence: true,
        highDefensiveness: false,
        userText,
      };


      const forcedRenderMode =
        (metaForSave as any)?.renderMode ?? (metaForSave as any)?.extra?.renderMode ?? undefined;

      const shouldRunRenderReply = forcedRenderMode === 'IT';

      let renderedText = assistantText;

      if (shouldRunRenderReply) {
        renderedText = renderReply(vector as any, input as any, {
          mode: 'transcend',
          maxLines: 14,
          ...({
            renderMode: 'IT',
            itDensity:
              (metaForSave as any)?.extra?.itDensity ??
              (((metaForSave as any)?.extra?.itTriggerKind ??
                (metaForSave as any)?.itTriggerKind) === 'button'
                ? 'normal'
                : 'micro'),
            spinLoop,
            descentGate,
            framePlan,
            spinStep,
          } as any),
        } as any);
      }

      const out = toNonEmptyString(renderedText);
      if (out) {
        finalAssistantText = out;

        if (shouldRunRenderReply) {
          (metaForSave as any).extra = (metaForSave as any).extra ?? {};
          (metaForSave as any).extra.renderedBy = 'renderReply';
          (metaForSave as any).extra.renderedMode = 'IT';
        }
      }

      console.log('[IROS/PostProcess] renderReply applied', {
        userCode,
        renderMode: (metaForSave as any)?.renderMode ?? null,
        len: out ? out.length : 0,
        spinLoop,
        spinStep,
        descentGate,
        shouldRunRenderReply,
      });
    } catch (e) {
      console.warn('[IROS/PostProcess] renderReply failed (fallback to assistantText)', e);
    }
  }

  return { assistantText: finalAssistantText, metaForSave };
}
