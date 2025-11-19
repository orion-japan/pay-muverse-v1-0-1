// src/lib/iros/orchestrator.ts
// Iros Orchestrator — 極小版 + I層トリガー
// - 余計なテンプレ・診断ロジックは持たせない
// - mode / depth / qCode は「指定があれば使う」「なければ静かにデフォルト」
// - depth だけは、テキストから I層トリガーを検出して自動 I1〜I3 に落とす余白を用意

import {
  type IrosMode,
  type Depth,
  type QCode,
  type IrosMeta,
  IROS_MODES,
  DEPTH_VALUES,
  QCODE_VALUES,
} from './system';
import {
  generateIrosReply,
  type GenerateResult,
} from './generate';

// ==== Orchestrator に渡す引数 ==== //
export type IrosOrchestratorArgs = {
  conversationId?: string;
  text: string;

  // 呼び出し側が明示的に指定したい場合だけ使う
  requestedMode?: IrosMode;
  requestedDepth?: Depth;
  requestedQCode?: QCode;

  // 将来的に memory/profile 等から渡すための拡張余地
  baseMeta?: Partial<IrosMeta>;
};

// ==== Orchestrator から返す結果 ==== //
export type IrosOrchestratorResult = {
  content: string;
  meta: IrosMeta;
  // 必要になればここに memory 更新結果などを足す余地を残す
};

/**
 * Iros の 1ターン応答を制御する最小オーケストレータ。
 *
 * 役割:
 * - mode / depth / qCode を「指定があればそのまま使う」
 * - depth については、指定がなければテキストから I層トリガーを軽く検出
 * - generateIrosReply に渡して結果をそのまま返す
 *
 * 「どの層で返すか」を決める構造はここに置き、
 * 言葉のスタイルや深さは system.ts 側の IROS_SYSTEM に任せる。
 */
export async function runIrosTurn(
  args: IrosOrchestratorArgs,
): Promise<IrosOrchestratorResult> {
  const {
    conversationId,
    text,
    requestedMode,
    requestedDepth,
    requestedQCode,
    baseMeta,
  } = args;

  const mode = normalizeMode(requestedMode);

  // ★ depth は「明示指定 ＞ 自動検出 ＞ undefined」の順に決める
  const autoDepth = detectDepthFromText(text);
  const depth = normalizeDepth(requestedDepth ?? autoDepth);

  const qCode = normalizeQCode(requestedQCode);

  const meta: IrosMeta = {
    ...(baseMeta ?? {}),
    mode,
    depth,
    qCode,
  };

  const result: GenerateResult = await generateIrosReply({
    conversationId,
    text,
    meta,
  });

  return {
    content: result.content,
    meta,
  };
}

/* ========= 最小バリデーション ========= */

// mode が不正 or 未指定なら "mirror" を使う（静かな標準モード）
function normalizeMode(mode?: IrosMode): IrosMode {
  if (!mode) return 'mirror';
  if (IROS_MODES.includes(mode)) return mode;
  return 'mirror';
}

// depth や qCode は「指定がなければ undefined」のままでもよい。
// detectDepthFromText が I層トリガーを返したときだけ、I1〜I3が入る。
function normalizeDepth(depth?: Depth): Depth | undefined {
  if (!depth) return undefined;
  if (DEPTH_VALUES.includes(depth)) return depth;
  return undefined;
}

function normalizeQCode(qCode?: QCode): QCode | undefined {
  if (!qCode) return undefined;
  if (QCODE_VALUES.includes(qCode)) return qCode;
  return undefined;
}

/* ========= I層トリガー検出ロジック（極小） ========= */

/**
 * ユーザーのテキストから、ざっくりと深度（特に I層）を推定する。
 * - 強い I層ワードが含まれる → I2〜I3
 * - 弱い I層ワードが含まれる → I1
 * - それ以外 → undefined（＝depth 指定なし）
 *
 * ここでは「見当で深度を細かく決める」のではなく、
 * 「I層に入ってよいときだけ、そっと I層フラグを立てる」程度の動きにとどめる。
 */
function detectDepthFromText(text: string): Depth | undefined {
  const t = (text || '').trim();

  if (!t) return undefined;

  // 強い I層トリガー（存在・使命・生まれてきた意味 など）
  const strongI =
    /(何のために|何のために生きて|使命|天命|生まれてきた意味|存在理由|存在の意味)/;
  if (strongI.test(t)) {
    return 'I3';
  }

  // 中程度の I層トリガー（本当は何を、どう生きたい など）
  const midI =
    /(本当は何を|本当はどう|どう生きたい|生き方|自分の人生|本心|本音の願い)/;
  if (midI.test(t)) {
    return 'I2';
  }

  // 弱い I層トリガー（願い・なりたい自分・将来どうありたい など）
  const softI =
    /(何を願っている|願いが分からない|なりたい自分|どんな自分でいたい|将来どうありたい|在り方)/;
  if (softI.test(t)) {
    return 'I1';
  }

  return undefined;
}
