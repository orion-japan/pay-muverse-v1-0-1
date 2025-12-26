// src/lib/iros/memory/state.ts
// Iros Memory State — 中長期の「流れ」を保持する状態モデル + 更新ロジック
// - DB テーブル iros_memory_state と 1:1 対応
// - 1ターンごとの meta から「今の位置」と「これまでの積み重ね」を更新する

import type { Depth, QCode, IrosMeta } from '../system';
import { inferMetrics } from './metrics';

type Phase = 'Inner' | 'Outer';

/* ========= 型定義 ========= */

/**
 * ✅ q_counts は「Q1〜Q5の累積」だけでなく、運用上の付帯情報を内包し得る
 * 例：
 * - it_cooldown: number
 * - q_trace: { prevQ, qNow, streakQ, streakLength, from }
 * など（persist 層が追加しても壊れないようにする）
 */
export type QCounts = Record<QCode, number> & {
  it_cooldown?: number;
  q_trace?: any;
  [k: string]: any;
};

/** DB テーブル iros_memory_state に対応する状態オブジェクト */
export type IrosMemoryState = {
  userCode: string;
  summary: string | null; // ざっくりした最近3ヶ月の流れ
  depthStage: Depth | null; // いま主に滞在しているレイヤー（S1〜I3）
  tone: string | null; // 雰囲気・トーン（静けさ / 緊張 / 希望 など簡易ラベル）
  theme: string | null; // 主なテーマ（仕事 / 恋愛 / 自己 / 家族 / 創造 など）
  lastKeyword: string | null; // 直近のキーワード（会話のフックになる語）
  qPrimary: QCode | null; // 代表的な Q の色
  qCounts: QCounts; // Q1〜Q5 の累積カウント + 付帯情報（任意）
  phase: Phase | null; // Inner / Outer （3軸意思決定用のフェーズ）
  updatedAt?: string; // ISO 文字列（DB の updated_at と対応）
};

/** 1ターン分の入力（会話本文 + Iros メタ） */
export type MemoryTurnInput = {
  userCode: string;
  text: string;
  meta: IrosMeta;
};

/* ========= 初期状態 ========= */

function createBaseQCounts(): QCounts {
  return { Q1: 0, Q2: 0, Q3: 0, Q4: 0, Q5: 0 };
}

export function createEmptyMemoryState(userCode: string): IrosMemoryState {
  return {
    userCode,
    summary: null,
    depthStage: null,
    tone: null,
    theme: null,
    lastKeyword: null,
    qPrimary: null,
    qCounts: createBaseQCounts(),
    phase: null,
    updatedAt: new Date().toISOString(),
  };
}

/* ========= 正規化ヘルパー ========= */

function toFiniteInt(v: unknown, fallback = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  // DB / 集計用途なので、負数は落とす（0以上）
  return Math.max(0, Math.floor(v));
}

function normalizePhase(v: unknown): Phase | null {
  if (typeof v !== 'string') return null;
  const p = v.trim().toLowerCase();
  if (p === 'inner') return 'Inner';
  if (p === 'outer') return 'Outer';
  return null;
}

function coalescePhaseFromMeta(meta: any): Phase | null {
  // camel / snake / 別名ゆれを拾う
  const raw =
    meta?.phase ??
    meta?.phase_mode ??
    meta?.phaseMode ??
    meta?.unified?.phase ??
    meta?.unified?.phase_mode ??
    meta?.unified?.phaseMode ??
    null;
  return normalizePhase(raw);
}

function coalesceQFromMeta(meta: any, metrics: any): QCode | null {
  return (
    meta?.qCode ??
    meta?.q_code ??
    meta?.unified?.q?.current ??
    meta?.unified?.q?.q_current ??
    metrics?.q_primary ??
    null
  );
}

function coalesceDepthFromMeta(meta: any, metrics: any): Depth | null {
  return (
    meta?.depth ??
    meta?.depth_stage ??
    meta?.unified?.depth?.stage ??
    meta?.unified?.depth?.depth_stage ??
    (metrics?.depth as Depth | null) ??
    null
  );
}

/* ========= DB <-> Domain 変換ヘルパー ========= */

/**
 * DB 行（Supabase から返ってくるオブジェクト）をドメイン状態に変換
 */
export function mapRowToMemoryState(row: any | null): IrosMemoryState | null {
  if (!row) return null;

  const base = createBaseQCounts();
  const raw = row.q_counts && typeof row.q_counts === 'object' ? row.q_counts : {};

  // Q1〜Q5 の数値だけ厳密に拾う（その他の付帯情報は後で合成）
  const qCountsCore: QCounts = {
    ...base,
    Q1: toFiniteInt(raw.Q1, 0),
    Q2: toFiniteInt(raw.Q2, 0),
    Q3: toFiniteInt(raw.Q3, 0),
    Q4: toFiniteInt(raw.Q4, 0),
    Q5: toFiniteInt(raw.Q5, 0),
  };

  // 付帯情報（it_cooldown / q_trace / その他）を保持
  const qCountsExtra: Record<string, any> =
    raw && typeof raw === 'object' ? { ...(raw as any) } : {};
  delete qCountsExtra.Q1;
  delete qCountsExtra.Q2;
  delete qCountsExtra.Q3;
  delete qCountsExtra.Q4;
  delete qCountsExtra.Q5;

  const qCounts: QCounts = { ...qCountsCore, ...qCountsExtra };

  return {
    userCode: row.user_code,
    summary: row.summary ?? null,
    depthStage: (row.depth_stage as Depth | null) ?? null,
    tone: row.tone ?? null,
    theme: row.theme ?? null,
    lastKeyword: row.last_keyword ?? null,
    qPrimary: (row.q_primary as QCode | null) ?? null,
    qCounts,
    phase: normalizePhase(row.phase) ?? null,
    updatedAt: row.updated_at ?? undefined,
  };
}

/**
 * ドメイン状態を DB upsert 用の形にシリアライズ
 * - ここではカラム名を iros_memory_state に合わせておく
 */
export function serializeMemoryStateForDB(state: IrosMemoryState) {
  return {
    user_code: state.userCode,
    summary: state.summary,
    depth_stage: state.depthStage,
    tone: state.tone,
    theme: state.theme,
    last_keyword: state.lastKeyword,
    q_primary: state.qPrimary,
    q_counts: state.qCounts,
    phase: state.phase,
    updated_at: state.updatedAt ?? new Date().toISOString(),
  };
}

/* ========= メイン：1ターン分から次の MemoryState を計算 ========= */

/**
 * 1ターン分の会話から MemoryState を更新するメイン関数
 * - DB 書き込みは行わず、純粋に「次の状態」を返す
 * - 実際の upsert は memory.adapter.ts 側で serializeMemoryStateForDB を使って行う想定
 *
 * ✅重要：
 * - persist層が q_counts に付帯情報を入れる可能性があるため、
 *   ここでは「Q1〜Q5だけを更新」し、それ以外のキーは温存する
 */
export function updateMemoryStateFromTurn(
  prevState: IrosMemoryState | null,
  input: MemoryTurnInput,
): IrosMemoryState {
  const base =
    prevState && prevState.userCode === input.userCode
      ? { ...prevState }
      : createEmptyMemoryState(input.userCode);

  const { text, meta } = input;

  // ★ テキストからの共鳴メトリクス（Phase / Depth / Q）を推定
  const metrics = inferMetrics(text);

  // 6) フェーズ（Inner / Outer）の更新
  const phaseFromMeta = coalescePhaseFromMeta(meta);
  const phaseFromMetrics: Phase | null = normalizePhase(metrics?.phase ?? null);

  const phase: Phase | null = phaseFromMeta ?? phaseFromMetrics ?? base.phase ?? null;

  // 1) Q の更新（カウント + 代表Q）
  const qFromMeta: QCode | null = coalesceQFromMeta(meta, metrics);

  // ✅ qCounts は「既存の付帯情報」も含めて温存しつつ、Q1〜Q5だけ更新する
  const nextQCounts: QCounts = {
    ...(base.qCounts ?? {}),
    ...createBaseQCounts(), // 5キーを必ず揃える（足りないDB行でも落ちない）
    Q1: toFiniteInt((base.qCounts as any)?.Q1, 0),
    Q2: toFiniteInt((base.qCounts as any)?.Q2, 0),
    Q3: toFiniteInt((base.qCounts as any)?.Q3, 0),
    Q4: toFiniteInt((base.qCounts as any)?.Q4, 0),
    Q5: toFiniteInt((base.qCounts as any)?.Q5, 0),
  };

  if (qFromMeta) {
    nextQCounts[qFromMeta] = toFiniteInt(nextQCounts[qFromMeta], 0) + 1;
  }

  const qPrimary = decidePrimaryQ(qFromMeta, nextQCounts, base.qPrimary);

  // 2) 深度（Depth）の更新
  const depthFromMeta: Depth | null = coalesceDepthFromMeta(meta, metrics);
  const depthStage = depthFromMeta ?? base.depthStage ?? null;

  // 3) トーンの推定
  const tone = deriveTone({
    qPrimary,
    depthStage,
    prevTone: base.tone,
  });

  // 4) テーマの推定（仕事 / 恋愛 / 自己 / 家族 / 創造 …）
  const theme = deriveTheme({
    text,
    prevTheme: base.theme,
  });

  // 5) last_keyword の更新
  const lastKeyword = extractLastKeyword(text) ?? base.lastKeyword;

  // 7) サマリーはここでは軽く更新フラグだけ
  //    本格的な要約は summarizeClient.ts など別モジュールで上書きする想定
  const summary = base.summary ?? buildInitialSummary(theme, depthStage);

  return {
    ...base,
    summary,
    depthStage,
    tone,
    theme,
    lastKeyword,
    qPrimary,
    qCounts: nextQCounts,
    phase,
    updatedAt: new Date().toISOString(),
  };
}

/* ========= Q / Depth 由来のヘルパー ========= */

function decidePrimaryQ(
  latestQ: QCode | null,
  qCounts: Record<QCode, number>,
  prevPrimary: QCode | null,
): QCode | null {
  // 1) 直近の Q があれば、それを優先しても良いが
  //    「累積で見たときの代表色」を基本とする
  let bestQ: QCode | null = prevPrimary ?? null;
  let bestCount = bestQ ? qCounts[bestQ] ?? 0 : -1;

  (['Q1', 'Q2', 'Q3', 'Q4', 'Q5'] as QCode[]).forEach((q) => {
    const c = qCounts[q] ?? 0;
    if (c > bestCount) {
      bestQ = q;
      bestCount = c;
    }
  });

  // 直近 Q があり、かつカウント差がほぼ同じなら、直近を優先
  if (latestQ) {
    const latestCount = qCounts[latestQ] ?? 0;
    if (bestQ === null || Math.abs(latestCount - bestCount) <= 1) {
      return latestQ;
    }
  }

  return bestQ;
}

function deriveTone(params: {
  qPrimary: QCode | null;
  depthStage: Depth | null;
  prevTone: string | null;
}): string | null {
  const { qPrimary, depthStage, prevTone } = params;

  if (!qPrimary && !depthStage) return prevTone ?? null;

  // Q をベースに大まかなトーンを決める
  let tone: string | null = null;

  switch (qPrimary) {
    case 'Q1':
      tone = '静かに整理したいムード';
      break;
    case 'Q2':
      tone = '変化や成長へのエネルギー';
      break;
    case 'Q3':
      tone = '安心・安定を求める流れ';
      break;
    case 'Q4':
      tone = '浄化・手放し・深い吐息のようなムード';
      break;
    case 'Q5':
      tone = '情熱やひらめきが灯っている状態';
      break;
    default:
      tone = prevTone ?? null;
  }

  // I層が強いときは、一段だけトーンに「存在」寄りのニュアンスを足す
  if (depthStage && /^I[1-3]$/.test(depthStage)) {
    tone = tone
      ? `${tone}（存在や生き方まで含んだ話が開きつつある）`
      : '存在や生き方そのものに触れているムード';
  }

  return tone;
}

/* ========= テーマ / キーワード推定ロジック ========= */

function deriveTheme(params: { text: string; prevTheme: string | null }): string | null {
  const { text, prevTheme } = params;
  const t = (text || '').trim();
  if (!t) return prevTheme ?? null;

  // ✅ 正規表現の誤り修正：
  // 以前の /[仕事|会社|...]/ は「文字クラス」なので意図どおり動かない
  if (/(仕事|会社|上司|部下|同僚|職場|プロジェクト)/.test(t)) {
    return '仕事・キャリア';
  }
  if (/(恋愛|彼氏|彼女|好きな人|パートナー|結婚)/.test(t)) {
    return '恋愛・パートナーシップ';
  }
  if (/(家族|親|子ども|夫|妻)/.test(t)) {
    return '家族・身近な人間関係';
  }
  if (/(創りたい|つくりたい|表現|作品|アート|クリエイティブ)/.test(t)) {
    return '創造・表現';
  }
  if (/(自分らしく|本当の自分|生き方|在り方|自己理解)/.test(t)) {
    return '自己・在り方';
  }

  // 特定できないなら前のテーマを維持
  return prevTheme ?? null;
}

/**
 * ざっくりとした「直近のキーワード」を抜き出す
 * - 日本語なので完全な形態素解析はせず、
 *   末尾近くの意味ありげなフレーズをそのまま切り出す
 */
function extractLastKeyword(text: string): string | null {
  const t = (text || '').trim();
  if (!t) return null;

  // 改行が多い場合は、最後の行を採用
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : t;

  // 句読点・記号でざっくり区切り、いちばん末尾の断片をキーワードとする
  const parts = lastLine
    .split(/[。！？!?,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) return lastLine.slice(-20); // フォールバック

  const candidate = parts[parts.length - 1];
  // あまりに短い/長い場合は素直に末尾20文字にする
  if (candidate.length < 2 || candidate.length > 30) {
    return lastLine.slice(-20);
  }
  return candidate;
}

/* ========= サマリー初期値（本格要約クライアントとの連携前の仮置き） ========= */

function buildInitialSummary(theme: string | null, depthStage: Depth | null): string | null {
  if (!theme && !depthStage) return null;

  const themePart = theme ? `${theme} をめぐる流れの中で` : '最近の出来事の中で';

  if (depthStage && /^I[1-3]$/.test(depthStage)) {
    return `${themePart}、生き方や存在レベルの問いにも静かに触れ続けている状態です。`;
  }

  if (depthStage && /^C[1-3]$/.test(depthStage)) {
    return `${themePart}、具体的な動きや選択を少しずつ形にしようとしている状態です。`;
  }

  if (depthStage && /^R[1-3]$/.test(depthStage)) {
    return `${themePart}、人との関係性や場の空気をていねいに見直している状態です。`;
  }

  if (depthStage && /^S[1-4]$/.test(depthStage)) {
    return `${themePart}、自分の気持ちやコンディションを静かに整え直している状態です。`;
  }

  return `${themePart}、自分の状態や感情の揺れを整理し続けている状態です。`;
}
