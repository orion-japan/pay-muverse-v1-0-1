// src/lib/iros/orchestrator.ts
// Iros Orchestrator — 極小版 + I層トリガー
// - 余計なテンプレ・診断ロジックは持たせない
// - mode / depth / qCode は「指定があれば使う」「なければ静かにデフォルト」
// - depth だけは、テキストから I層トリガーを検出して自動 I1〜I3 に落とす

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

  // memory / Qトレースなどから渡されるベース情報
  baseMeta?: Partial<IrosMeta>;
};

// ==== Orchestrator から返す結果 ==== //
export type IrosOrchestratorResult = {
  content: string;
  meta: IrosMeta;
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

  // ★ テキストからの自動検出
  const autoDepth = detectDepthFromText(text);

  // ★ depth の優先順位:
  //   1) autoDepth が I層(I1〜I3)なら最優先
  //   2) それ以外は requestedDepth（＝Qメモリ S/R/C/I）を使う
  //   3) それもなければ autoDepth（将来 S/R/C 自動推定を足す余白）
  const rawDepth: Depth | undefined = (() => {
    if (autoDepth && autoDepth.startsWith('I')) {
      return autoDepth;
    }
    return requestedDepth ?? autoDepth;
  })();

  const depth = normalizeDepth(rawDepth);
  const qCode = normalizeQCode(requestedQCode);

  // ★ meta のマージ:
  // - baseMeta をベースに
  // - depth / qCode が決まっているときだけ上書きする
  const meta: IrosMeta = {
    ...(baseMeta ?? {}),
    mode,
    ...(depth ? { depth } : {}),
    ...(qCode ? { qCode } : {}),
  } as IrosMeta;

  // ===== v2 ログ（反映確認用） =====
  console.log('[IROS/ORCH v2] runIrosTurn start', {
    conversationId,
    textSample: text.slice(0, 80),
    requestedMode,
    requestedDepth,
    requestedQCode,
    autoDepth,
    chosenDepth: depth,
    resolved: { mode, depth, qCode },
    baseMeta,
    finalMeta: meta,
  });
  // ==============================

  const result: GenerateResult = await generateIrosReply({
    conversationId,
    text,
    meta,
  });

  console.log('[IROS/ORCH v2] runIrosTurn done', {
    conversationId,
    resolved: { mode, depth, qCode },
    replyLength: result.content.length,
  });

  return {
    content: result.content,
    meta,
  };
}

/* ========= 最小バリデーション ========= */

function normalizeMode(mode?: IrosMode): IrosMode {
  if (!mode) return 'mirror';
  if (IROS_MODES.includes(mode)) return mode;
  return 'mirror';
}

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
 */
function detectDepthFromText(text: string): Depth | undefined {
  const t = (text || '').trim();
  if (!t) return undefined;

  // 強い I層トリガー
  const strongI =
    /(何のために|何のために生きて|使命|天命|生まれてきた意味|存在理由|存在の意味)/;
  if (strongI.test(t)) return 'I3';

  // 中程度の I層トリガー
  const midI =
    /(本当は何を|本当はどう|どう生きたい|生き方|自分の人生|本心|本音の願い)/;
  if (midI.test(t)) return 'I2';

  // 弱い I層トリガー
  const softI =
    /(何を願っている|願いが分からない|なりたい自分|どんな自分でいたい|将来どうありたい|在り方)/;
  if (softI.test(t)) return 'I1';

  return undefined;
}
