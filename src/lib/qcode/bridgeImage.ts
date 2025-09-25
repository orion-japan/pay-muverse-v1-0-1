// Mu 画像生成ブリッジ：定型文の提供とクレジット見積・記録用ペイロード生成

import { MU_BRIDGE_TEXT, MU_Q_LINK } from "@/lib/mu/config";
import { muCreditPolicy, muQTag, type MuQTags } from "./muPolicy";

export type ImageStyle = "写実" | "シンプル" | "手描き風";
export type ImageBridgePhase = "suggest" | "confirmStyle" | "done";
export type ImageGenStatus = "success" | "fail";

// MU_Q_LINK.INTENT_TAGS の要素型を安全に参照
export type IntentTag = (typeof MU_Q_LINK.INTENT_TAGS)[number];

export type BuildBridgeTextParams =
  | { phase: "suggest"; costOverride?: number }
  | { phase: "confirmStyle" }
  | { phase: "done"; previewLine?: string };

export function buildImageBridgeText(p: BuildBridgeTextParams): string {
  if (p.phase === "suggest") {
    return MU_BRIDGE_TEXT.SUGGEST_IMAGE(p.costOverride ?? muCreditPolicy.imageGen.cost);
  }
  if (p.phase === "confirmStyle") {
    return MU_BRIDGE_TEXT.ASK_STYLE;
  }
  // done
  const preview = p.previewLine ? `\n${MU_BRIDGE_TEXT.PREVIEW_PREFIX}${p.previewLine}` : "";
  return `${MU_BRIDGE_TEXT.DONE_SAVED}${preview}`;
}

/** 画像スタイルの正規化（未指定は "シンプル"） */
export function normalizeImageStyle(input?: string | null): ImageStyle {
  const s = (input ?? "").trim();
  if (/写実/.test(s)) return "写実";
  if (/手描き|手書き|sketch|draw/i.test(s)) return "手描き風";
  return "シンプル";
}

/** 見積: Mu 画像生成のクレジット */
export function estimateMuImageCredits(): number {
  return muCreditPolicy.imageGen.cost;
}

export type RecordMuImageGenParams = {
  user_code: string;
  status: ImageGenStatus;
  // 失敗時にも課金するなら true（既定: false＝0課金）
  chargeOnFailure?: boolean;
  // ログ付帯情報
  conversation_id?: string;
  message_id?: string;
  intentTag?: IntentTag;
  style?: ImageStyle;
  prompt_summary?: string;
  meta?: Record<string, unknown>;
};

export type RecordMuImageGenResult = {
  ok: boolean;
  used_credits: number;
  schema: string;
  tags: MuQTags;
  user_code: string;
  status: ImageGenStatus;
  at: string; // ISO
  conversation_id?: string;
  message_id?: string;
  intentTag?: string;
  style?: ImageStyle;
  prompt_summary?: string;
  meta?: Record<string, unknown>;
};

/** 記録ペイロード作成（副作用なし：上位でDB/台帳へ渡す） */
export async function recordMuImageGen(
  params: RecordMuImageGenParams
): Promise<RecordMuImageGenResult> {
  const { status, chargeOnFailure = false } = params;

  const cost =
    status === "success"
      ? muCreditPolicy.imageGen.cost
      : chargeOnFailure
      ? muCreditPolicy.imageGen.cost
      : 0;

  const tags = muQTag("imageGen");

  return {
    ok: true,
    used_credits: cost,
    schema: muCreditPolicy.imageGen.schema,
    tags,
    user_code: params.user_code,
    status,
    at: new Date().toISOString(),
    conversation_id: params.conversation_id,
    message_id: params.message_id,
    intentTag: params.intentTag,
    style: params.style,
    prompt_summary: params.prompt_summary,
    meta: params.meta,
  };
}
