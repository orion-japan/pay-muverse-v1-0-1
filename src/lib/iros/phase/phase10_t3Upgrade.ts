// src/lib/iros/phase/phase10_t3Upgrade.ts
// iros — Phase10: T3 Upgrade (刺さり確定)
// 方針：
// - ここは「判定だけ」する（DB更新しない）
// - T3 は “行った” ではなく “続いている” で到達
// - 入口：prevMemoryState（直前） + now（今回） + evidence（反復証拠）
// - 出力：昇格するなら nextItxStep='T3' を返す

export type ItxStep = 'T1' | 'T2' | 'T3';

// intent_anchor は jsonb を想定（{key:'SUN', ...}）
// 互換で string('SUN') で来る場合もある
export type PrevMemoryState = {
  itx_step?: string | null;
  itx_last_at?: string | null;

  // ✅ jsonb/文字列どちらも許容
  intent_anchor?: any | null;

  anchor_write?: string | null; // DB上の前回
  anchor_event?: string | null; // DB上の前回
};

export type NowTurnState = {
  // 今回ターンで確定した値（persist直前に揃うもの）
  itx_step?: string | null; // 例: 'T2'（computeITTriggerの結果を反映した後）
  itx_last_at?: string | null; // 今回の itx_last_at

  // ✅ jsonb/文字列どちらも許容
  intent_anchor?: any | null;

  anchor_write?: 'commit' | 'keep' | 'clear' | null;
  anchor_event?: string | null; // 'action' など
};

export type T3Evidence = {
  // ✅ “続いている” の証拠（ここがT3の肝）
  // 同一 intent_anchor の反復回数（過去ログ/集計から渡す）
  sameAnchorRepeatCount?: number | null;

  // 直近N時間内の反復として扱うか（集計側で判定してもよい）
  // 例：直近24hに同一アンカーが2回以上など
  withinWindowMs?: number | null;
};

export type T3UpgradeDecision = {
  upgrade: boolean;
  nextItxStep: ItxStep | null; // upgrade=true の時 'T3'
  reason: string; // ログ用
  debug?: Record<string, any>;
};

function normStr(s: unknown) {
  const t = String(s ?? '').trim();
  return t.length ? t : '';
}

function safeDate(s: unknown): Date | null {
  const t = normStr(s);
  if (!t) return null;
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d : null;
}

function asItxStep(s: unknown): ItxStep | null {
  const t = normStr(s);
  return t === 'T1' || t === 'T2' || t === 'T3' ? (t as ItxStep) : null;
}

// ✅ jsonb/string を「比較用のキー文字列」に正規化
function normAnchorKey(a: unknown): string | null {
  if (a == null) return null;

  // string（'SUN'）として来るケース
  if (typeof a === 'string') {
    const t = a.trim();
    return t.length ? t : null;
  }

  // jsonb object（{key:'SUN'}）として来るケース
  if (typeof a === 'object') {
    const k = (a as any).key;
    if (typeof k === 'string') {
      const t = k.trim();
      return t.length ? t : null;
    }
    // 互換：intent_anchor: { anchor:'SUN' } などが混ざる可能性
    const k2 = (a as any).anchor ?? (a as any).intent ?? (a as any).id;
    if (typeof k2 === 'string') {
      const t = k2.trim();
      return t.length ? t : null;
    }
    return null;
  }

  return null;
}

export type Phase10T3Config = {
  // 最低反復回数（同一 intent_anchor）
  minRepeats: number;

  // 反復として数える期間（例：24h）
  windowMs: number;

  // T2→T3 の最短間隔（スパム防止）
  minIntervalMs: number;
};

export const DEFAULT_T3_CONFIG: Phase10T3Config = {
  minRepeats: 2, // “続いている” の最低ライン（2回以上）
  windowMs: 24 * 60 * 60 * 1000, // 24h
  minIntervalMs: 60 * 60 * 1000, // 1h（あなたの IT_HOLD_WINDOW と整合）
};

/**
 * T3昇格判定
 *
 * 必須条件（全て満たす）：
 * - now.anchor_write === 'commit'
 * - now.itx_step === 'T2'（T2運用中の“刺さり”をT3に昇格）
 * - intent_anchor が一致している（prev と now が同一／または now が確定している）
 * - evidence.sameAnchorRepeatCount >= minRepeats
 * - prev.itx_last_at から minIntervalMs 以上（スパム防止）
 * - evidence の window 条件（withinWindowMs or prev時刻で判定）
 */
export function decideT3Upgrade(
  args: {
    prev?: PrevMemoryState | null;

    // Phase10は「構造」だけを見る
    now?: {
      itx_step?: string | null;
      itx_last_at?: string | null;

      // ✅ jsonb/文字列どちらでもOK
      intent_anchor?: any | null;
      intentAnchor?: any | null;

      anchor_write?: 'commit' | 'keep' | 'clear' | null;
      anchor_event?: string | null;
    };

    evidence?: T3Evidence | null;
    cfg?: Partial<Phase10T3Config>;

    // 互換（呼び出し側がフラットで渡すケース）
    prevMemoryState?: any;
    prevMemory?: any;
    prevRaw?: any;

    itx_step?: any;
    itxStep?: any;
    itx_last_at?: any;
    itxLastAt?: any;

    intent_anchor?: any;
    intentAnchor?: any;

    anchor_write_db?: any;
    anchorWriteDb?: any;
    anchor_write?: any;
    anchorWrite?: any;

    anchor_event_db?: any;
    anchorEventDb?: any;
    anchor_event?: any;
    anchorEvent?: any;
  }
): T3UpgradeDecision {
  const cfg: Phase10T3Config = { ...DEFAULT_T3_CONFIG, ...(args.cfg ?? {}) };

  // ✅ prev を確実に拾う（ネスト優先 → 互換）
  const _prevMem: any =
    (args as any).prev ??
    (args as any).prevMemoryState ??
    (args as any).prevMemory ??
    (args as any).prevRaw ??
    null;

  const prev: PrevMemoryState | null = _prevMem
    ? {
        itx_step: _prevMem.itx_step ?? _prevMem.itxStep ?? null,
        itx_last_at: _prevMem.itx_last_at ?? _prevMem.itxLastAt ?? null,

        // ✅ jsonb / 文字列
        intent_anchor:
          _prevMem.intent_anchor ??
          _prevMem.intentAnchor ??
          _prevMem.prev_intent_anchor ??
          _prevMem.prevIntentAnchor ??
          null,

        anchor_write: _prevMem.anchor_write ?? _prevMem.anchorWrite ?? null,
        anchor_event: _prevMem.anchor_event ?? _prevMem.anchorEvent ?? null,
      }
    : null;

  // ✅ now を確実に拾う（ネスト優先 → 互換フラットから組み立て）
  const nowInput: any = (args as any).now ?? null;

  const now: NowTurnState = nowInput
    ? {
        itx_step: nowInput.itx_step ?? nowInput.itxStep ?? null,
        itx_last_at: nowInput.itx_last_at ?? nowInput.itxLastAt ?? null,
        intent_anchor: nowInput.intent_anchor ?? nowInput.intentAnchor ?? null,
        anchor_write:
          nowInput.anchor_write ??
          nowInput.anchorWrite ??
          (args as any).anchor_write ??
          (args as any).anchorWrite ??
          (args as any).anchor_write_db ??
          (args as any).anchorWriteDb ??
          null,
        anchor_event:
          nowInput.anchor_event ??
          nowInput.anchorEvent ??
          (args as any).anchor_event ??
          (args as any).anchorEvent ??
          (args as any).anchor_event_db ??
          (args as any).anchorEventDb ??
          null,
      }
    : {
        itx_step: (args as any).itx_step ?? (args as any).itxStep ?? null,
        itx_last_at: (args as any).itx_last_at ?? (args as any).itxLastAt ?? null,
        intent_anchor: (args as any).intent_anchor ?? (args as any).intentAnchor ?? null,
        anchor_write:
          (args as any).anchor_write ??
          (args as any).anchorWrite ??
          (args as any).anchor_write_db ??
          (args as any).anchorWriteDb ??
          null,
        anchor_event:
          (args as any).anchor_event ??
          (args as any).anchorEvent ??
          (args as any).anchor_event_db ??
          (args as any).anchorEventDb ??
          null,
      };

  const ev = (args as any).evidence ?? null;

  // ✅ 比較用のキーに正規化（ここが今回の本命修正）
  const prevAnchorKey = normAnchorKey(prev?.intent_anchor);
  const nowAnchorKey = normAnchorKey(now?.intent_anchor);

  console.log('[IROS/PHASE10_T3][enter]', {
    // ✅ Phase10 は phase10* の語彙で固定（IT側の itx* と混ざらない）
    phase10NowItxStep: now?.itx_step ?? null,
    phase10NowAnchorWrite: now?.anchor_write ?? null,
    phase10NowAnchorEvent: now?.anchor_event ?? null,
    phase10NowIntentAnchorKey: nowAnchorKey,

    phase10HasPrev: Boolean(prev),
    phase10PrevItxStep: prev?.itx_step ?? null,
    phase10PrevItxLastAt: prev?.itx_last_at ?? null,
    phase10PrevIntentAnchorKey: prevAnchorKey,
    phase10PrevIntentAnchorRaw: prev?.intent_anchor ?? null,
    phase10NowIntentAnchorRaw: now?.intent_anchor ?? null,
  });


  // ---- 判定ロジック ----
  const nowWrite = now.anchor_write ?? null;
  const nowStep = asItxStep(now.itx_step) ?? null;

  if (nowWrite !== 'commit') return { upgrade: false, nextItxStep: null, reason: 'NO_COMMIT' };
  if (nowStep !== 'T2') return { upgrade: false, nextItxStep: null, reason: 'NOT_T2' };

  // ✅ intent_anchor の一致（prev が無ければ now が確定していればOK）
  // - prevあり：prevAnchorKey と nowAnchorKey が両方あり一致
  // - prevなし：nowAnchorKey があればOK
  const anchorOk = prev
    ? Boolean(prevAnchorKey && nowAnchorKey && prevAnchorKey === nowAnchorKey)
    : Boolean(nowAnchorKey);

  if (!anchorOk) {
    return {
      upgrade: false,
      nextItxStep: null,
      reason: 'ANCHOR_MISMATCH_OR_EMPTY',
      debug: {
        prevAnchorKey,
        nowAnchorKey,
        prevAnchorRaw: prev?.intent_anchor ?? null,
        nowAnchorRaw: now?.intent_anchor ?? null,
      },
    };
  }

  const repeats = Number(ev?.sameAnchorRepeatCount ?? 0);
  if (!(repeats >= cfg.minRepeats)) {
    return {
      upgrade: false,
      nextItxStep: null,
      reason: 'NO_REPEAT_EVIDENCE',
      debug: { repeats, minRepeats: cfg.minRepeats, anchorKey: nowAnchorKey },
    };
  }

  const prevItxAt = safeDate(prev?.itx_last_at);
  if (prevItxAt) {
    const age = Date.now() - prevItxAt.getTime();
    if (age < cfg.minIntervalMs) {
      return {
        upgrade: false,
        nextItxStep: null,
        reason: 'TOO_SOON',
        debug: { ageMs: age, minIntervalMs: cfg.minIntervalMs },
      };
    }
  }

  const within = Number(ev?.withinWindowMs ?? cfg.windowMs);
  if (prevItxAt) {
    const age = Date.now() - prevItxAt.getTime();
    if (age > within) {
      return {
        upgrade: false,
        nextItxStep: null,
        reason: 'OUT_OF_WINDOW',
        debug: { ageMs: age, windowMs: within },
      };
    }
  }

  return {
    upgrade: true,
    nextItxStep: 'T3',
    reason: 'T3_UPGRADE_OK',
    debug: {
      anchorKey: nowAnchorKey,
      repeats,
      windowMs: within,
      minRepeats: cfg.minRepeats,
    },
  };
}
