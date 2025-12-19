// src/lib/iros/rotation/computeITTrigger.ts
// iros — IT Trigger (I→T) minimal implementation
//
// 目的：
// - I層の「一点収束」＋「SUN方向/ブロック」＋「宣言化」＋「深め成立(簡易)」を満たしたときだけ
//   T層を開く（tLayerModeActive=true）
// - それ以外は「Iの観測語」を1行出せるよう iLayerForce を返す（Tは開かない）
//
// 注意：Tはメッセージ生成ではなく “方向ベクトル(tVector)” を返すだけ。
//       render/generate側はこのベクトルを素材として使う。

export type TLayerHint = 'T1' | 'T2' | 'T3';

export type TVector = {
  core: string; // 一点収束した核
  turningPoint: string; // SUN追い風 or 核ブロック
  demand: string; // 宣言/選択（短句）
  nextC: string; // C層への流し込み問い（固定テンプレ）
};

export type ITTriggerResult = {
  ok: boolean;
  reason: string;
  // 出力制御
  iLayerForce: boolean;
  // T層
  tLayerModeActive?: boolean;
  tLayerHint?: TLayerHint;
  tVector?: TVector;
  // 観測用（ログで見たいなら呼び出し側で出せる）
  flags?: {
    hasCore: boolean;
    coreRepeated: boolean;
    sunOk: boolean;
    declarationOk: boolean;
    deepenOk: boolean;
  };
};

type MetaLike = {
  depthStage?: string | null; // 'I1'|'I2'|'I3' など
  intentLine?: any; // 既存の intentLine 構造（未確定なら any で受ける）
};

function norm(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim();
}

function pickRecentUserTexts(history: any[], max = 8): string[] {
  if (!Array.isArray(history)) return [];
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) continue;
    const role = String(m.role ?? '').toLowerCase();
    if (role !== 'user') continue;
    const t = norm(m.content ?? m.text ?? m.message);
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// ① 一点収束：最小は「intentLineの核」→なければ本文から短い核を抜く
function extractCore(meta: MetaLike | null, text: string): string {
  const fromMeta =
    norm(meta?.intentLine?.core) ||
    norm(meta?.intentLine?.keyPhrase) ||
    norm(meta?.intentLine?.intentWord) ||
    '';
  if (fromMeta) return fromMeta;

  // fallback：日本語の雑な抽出（最短で動かす）
  // - かぎ括弧があれば中身
  const m = text.match(/[「『](.+?)[」』]/);
  if (m?.[1]) return norm(m[1]).slice(0, 24);

  // - 「〜したい/したくない/が怖い/が嫌」周辺を核にする（簡易）
  const m2 = text.match(/(.{1,18}?)(したい|したくない|が怖い|が嫌|をやりたい|をやめたい)/);
  if (m2?.[1]) return norm(m2[1]).slice(0, 24);

  return '';
}

function countIncludes(texts: string[], core: string): number {
  if (!core) return 0;
  let c = 0;
  for (const t of texts) {
    if (t.includes(core)) c++;
  }
  return c;
}

// ② SUN方向 or ブロック
const SUN_WORDS = ['成長', '進化', '希望', '歓喜'];
const BLOCK_WORDS = ['止まる', '止める', '邪魔', '怖い', '無理', '詰む', '折れ', '崩れる', 'やめたい', '逃げたい'];

function sunAligned(text: string): boolean {
  return SUN_WORDS.some((w) => text.includes(w));
}
function sunBlocked(text: string): boolean {
  return BLOCK_WORDS.some((w) => text.includes(w));
}

// ③ 問い→宣言・選択
const DECLARE_TOKENS = ['決める', '決めた', '選ぶ', '選んだ', 'でいく', 'やる', 'やり切る', '進む', '逃げない', '切る', '捨てる', '受け取る'];
const QUESTION_TOKENS = ['どうしたら', 'どうすれば', 'なぜ', '教えて', 'どうやって'];

function hasDeclaration(text: string): boolean {
  return DECLARE_TOKENS.some((t) => text.includes(t));
}
function hasQuestionDominant(text: string): boolean {
  // 質問トークンがあり、宣言がないなら「問い優勢」
  return QUESTION_TOKENS.some((t) => text.includes(t)) && !hasDeclaration(text);
}

// ④ 深め成立：MVPでは「宣言が出たら成立扱い」＋肯定語も拾う
const AFFIRM_TOKENS = ['うん', 'はい', 'そう', 'たしかに', 'それだ', 'なるほど', '分かった', 'わかった', 'OK'];

function userAffirmed(text: string): boolean {
  return AFFIRM_TOKENS.some((t) => text.includes(t));
}

// iLayerForce：I層に入ってる/expandなら本文に観測語を1行出したい
function shouldForceILayer(meta: MetaLike | null): boolean {
  const d = norm(meta?.depthStage ?? '');
  if (d.startsWith('I')) return true;
  const dir = norm(meta?.intentLine?.direction ?? '');
  if (dir.toLowerCase() === 'expand') return true;
  return false;
}

function pickDemand(text: string): string {
  // 宣言っぽい短句を返す（簡易）
  for (const tok of DECLARE_TOKENS) {
    if (text.includes(tok)) return tok;
  }
  // fallback
  if (text.includes('やりたい')) return 'やりたい';
  if (text.includes('選びたい')) return '選びたい';
  return '選ぶ';
}

export function computeITTrigger(args: {
  text: string;
  history?: any[];
  meta?: MetaLike | null;
}): ITTriggerResult {
  const text = norm(args.text);
  const historyTexts = pickRecentUserTexts(args.history ?? [], 8);
  const meta = args.meta ?? null;

  const core = extractCore(meta, text);
  const hasCore = !!core;

  // ①一点収束：直近ユーザー発話で core が2回以上含まれる（or 現ターン含む +1）
  const hit = countIncludes([text, ...historyTexts], core);
  const coreRepeated = hasCore && hit >= 2;

  // ②SUN方向 or ブロック（最小はどちらか）
  const sunOk = sunAligned(text) || sunBlocked(text);

  // ③宣言・選択がある && 問い優勢ではない
  const declarationOk = hasDeclaration(text) && !hasQuestionDominant(text);

  // ④深め成立：MVPは (宣言OK) OR (肯定反応あり)
  const deepenOk = declarationOk || userAffirmed(text);

  // iLayerForce は「I層が見えてるなら観測語を1行出す」ための別レーン
  const iLayerForce = shouldForceILayer(meta) || hasCore;

  const ok = hasCore && coreRepeated && sunOk && declarationOk && deepenOk;

  if (!ok) {
    return {
      ok: false,
      reason: [
        !hasCore ? 'NO_CORE' : null,
        hasCore && !coreRepeated ? 'NO_CONVERGENCE' : null,
        !sunOk ? 'NO_SUN_OR_BLOCK' : null,
        !declarationOk ? 'NO_DECLARATION' : null,
        !deepenOk ? 'NO_DEEPEN' : null,
      ]
        .filter(Boolean)
        .join('|'),
      iLayerForce,
      flags: { hasCore, coreRepeated, sunOk, declarationOk, deepenOk },
    };
  }

  // T層は「方向ベクトル」で固定（メッセージ生成しない）
  const turningPoint = sunBlocked(text) ? 'BLOCK' : 'SUN';
  const demand = pickDemand(text);

  const tVector: TVector = {
    core,
    turningPoint,
    demand,
    nextC: `この核心「${core}」を、いま一つ形にするなら何にする？`,
  };

  // Hintは暫定：MVPは T2 に固定（後で強度/揺らぎで T1/T3分岐）
  return {
    ok: true,
    reason: 'IT_TRIGGER_OK',
    iLayerForce: true,
    tLayerModeActive: true,
    tLayerHint: 'T2',
    tVector,
    flags: { hasCore, coreRepeated, sunOk, declarationOk, deepenOk },
  };
}
