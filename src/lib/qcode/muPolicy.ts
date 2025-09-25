// Mu 用の Qコード／クレジット消費ポリシー定義（型を厳密化）

import { MU_CREDITS, MU_Q_LINK } from "@/lib/mu/config";

/** Mu のクレジット種別 */
export type MuCreditType = "textTurn" | "imageGen";

/** tags の厳密型（agent は "mu" のリテラル） */
export type MuQTags = {
  source_type: string;
  credit_schema: string;
  agent: "mu";
};

/** Mu のクレジット消費ルール */
export const muCreditPolicy = {
  textTurn: {
    label: "Mu テキスト1往復",
    cost: MU_CREDITS.TEXT_PER_TURN,
    schema: MU_Q_LINK.CREDIT_SCHEMA.textTurn,
  },
  imageGen: {
    label: "Mu 画像生成",
    cost: MU_CREDITS.IMAGE_PER_GEN,
    schema: MU_Q_LINK.CREDIT_SCHEMA.imageGen,
  },
} as const;

/** クレジット消費見積り関数 */
export function estimateMuCredits(kind: MuCreditType): number {
  return muCreditPolicy[kind].cost;
}

/** Qコード連動タグ付け（ログ用） */
export function muQTag(kind: MuCreditType) {
  return {
    source_type:
      kind === "textTurn" ? MU_Q_LINK.SOURCE_TYPE_TEXT : MU_Q_LINK.SOURCE_TYPE_IMAGE,
    credit_schema: muCreditPolicy[kind].schema,
    agent: "mu" as const,
  };
}
