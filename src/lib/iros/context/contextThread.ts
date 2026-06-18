import type { ActiveContextFrame, ActiveContextEntity } from "@/lib/iros/anchor/activeContextAnchor";

export type DiagnosisContextType = "ir" | "screenshot";

export type DiagnosisContextSource =
  | "iros_ir_diagnosis_results"
  | "mu_screenshot_diagnosis_logs"
  | "iros_memory_state"
  | "iros_messages.irMeta";

export type ContextThreadSource =
  | {
      type: "screenshot_diagnosis";
      displayId: number;
      sourceTable: "mu_screenshot_diagnosis_logs";
      sourceId: string | null;
      diagnosisType: "screenshot";
    }
  | {
      type: "ir_diagnosis";
      diagnosisId: string;
      sourceTable: "iros_ir_diagnosis_results";
      sourceId: string | null;
      diagnosisType: "ir";
    }
  | {
      type: "relationship_memory";
      relationId: string;
      sourceTable: "iros_relationship_memory";
    }
  | {
      type: "person_intent";
      targetKey: string;
      sourceTable: "iros_person_intent_state";
    };

export type ContextThread = {
  version: "context_thread_v1";
  code: string;
  type:
    | "screenshot_diagnosis_flow"
    | "ir_diagnosis_flow"
    | "relationship_flow"
    | "person_flow"
    | "relationship_diagnosis_flow"
    | "general_flow";
  status: "active" | "paused" | "closed";
  userCode: string;
  conversationId: string | null;
  targetLabel: string | null;
  targetKey: string | null;
  relationId: string | null;
  activeSources: ContextThreadSource[];
  lastUserIntent: string | null;
  lastUserText: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAfterTurns?: number;
  needsClarification?: boolean;
  clarificationReason?: string | null;
};

function cleanString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : null;
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function makeCodePart(value: unknown): string {
  const s = cleanString(value) ?? "unknown";
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "unknown"
  );
}

export function buildContextThreadFromDiagnosisContext(args: {
  userCode: string;
  conversationId?: string | null;
  diagnosisType: DiagnosisContextType;
  source: DiagnosisContextSource;
  id?: string | null;
  displayId?: number | null;
  targetLabel?: string | null;
  targetKey?: string | null;
  relationId?: string | null;
  userText?: string | null;
  nowIso?: string | null;
}): ContextThread {
  const nowIso = args.nowIso || new Date().toISOString();

  const type =
    args.diagnosisType === "screenshot"
      ? "screenshot_diagnosis_flow"
      : "ir_diagnosis_flow";

  const code =
    args.relationId && args.diagnosisType === "screenshot" && args.displayId
      ? `user:${makeCodePart(args.userCode)}:relation:${makeCodePart(args.relationId)}:screenshot:${args.displayId}`
      : args.diagnosisType === "screenshot" && args.displayId
        ? `user:${makeCodePart(args.userCode)}:screenshot:${args.displayId}`
        : args.relationId && args.id
          ? `user:${makeCodePart(args.userCode)}:relation:${makeCodePart(args.relationId)}:diagnosis:${makeCodePart(args.id)}`
          : `user:${makeCodePart(args.userCode)}:diagnosis:${makeCodePart(args.id ?? args.targetKey ?? args.targetLabel ?? "unknown")}`;

  const activeSources: ContextThreadSource[] =
    args.diagnosisType === "screenshot"
      ? [
          {
            type: "screenshot_diagnosis",
            displayId: Number(args.displayId ?? 0),
            sourceTable: "mu_screenshot_diagnosis_logs",
            sourceId: args.id ?? (args.displayId ? String(args.displayId) : null),
            diagnosisType: "screenshot",
          },
        ]
      : [
          {
            type: "ir_diagnosis",
            diagnosisId: String(args.id ?? args.targetKey ?? args.targetLabel ?? "unknown"),
            sourceTable: "iros_ir_diagnosis_results",
            sourceId: args.id ?? null,
            diagnosisType: "ir",
          },
        ];

  return {
    version: "context_thread_v1",
    code,
    type,
    status: "active",
    userCode: args.userCode,
    conversationId: args.conversationId ?? null,
    targetLabel: args.targetLabel ?? null,
    targetKey: args.targetKey ?? null,
    relationId: args.relationId ?? null,
    activeSources,
    lastUserIntent: args.userText ?? null,
    lastUserText: args.userText ?? null,
    createdAt: nowIso,
    lastUsedAt: nowIso,
    expiresAfterTurns: 6,
  };
}

export function getContextThreadFromMeta(meta: unknown): ContextThread | null {
  const obj = asObject(meta);
  const candidates = [
    obj?.contextThread,
    obj?.extra?.contextThread,
    obj?.extra?.ctxPack?.contextThread,
    obj?.ctxPack?.contextThread,
  ];

  for (const item of candidates) {
    const c = asObject(item);
    if (c?.version === "context_thread_v1" && c?.status === "active") {
      return c as ContextThread;
    }
  }

  return null;
}

export function getActiveContextFrameFromMeta(meta: unknown): ActiveContextFrame | null {
  const obj = asObject(meta);
  const candidates = [
    obj?.activeContextFrame,
    obj?.extra?.activeContextFrame,
    obj?.extra?.ctxPack?.activeContextFrame,
    obj?.ctxPack?.activeContextFrame,
  ];

  for (const item of candidates) {
    const c = asObject(item);
    if (
      c?.version === "active_context_frame_v1" &&
      Array.isArray(c.entities) &&
      Array.isArray(c.edges)
    ) {
      return c as ActiveContextFrame;
    }
  }

  return null;
}

export function isExplicitContextExit(userText: unknown): boolean {
  const s = cleanString(userText) ?? "";
  return /(別件|通常チャット|普通の相談|戻ります|戻る|終了|ここまで|新しい相談|切り替え|コードの話|実装の話|Muverseの話|料金の話)/u.test(s);
}

export function shouldContinueContextThread(userText: unknown): boolean {
  const s = cleanString(userText) ?? "";
  if (!s || isExplicitContextExit(s)) return false;

  return /(続き|もう少し|詳しく|深く|深めて|なぜ|どうして|なんで|理由|相手|反応|返し|返事|どう返|私が悪い|そう言う事じゃない|この場合|この流れ|それ|その|さっき|前の)/u.test(s);
}

function getPrimaryEntity(frame: ActiveContextFrame): ActiveContextEntity | null {
  return frame.entities.find((e) => e.id === frame.primaryEntityId) ?? frame.entities[0] ?? null;
}

export function buildWorkingReferenceFromActiveContextFrame(
  frame: ActiveContextFrame | null | undefined,
  userText: unknown,
  options?: {
    sourcePhrase?: string;
    confidence?: number;
  }
): any | null {
  if (!frame) return null;

  const primary = getPrimaryEntity(frame);
  if (!primary) return null;

  const referenceTarget = cleanString(primary.sourceText);
  if (!referenceTarget) return null;

  const mainSubject =
    cleanString(primary.label) ??
    cleanString(primary.key) ??
    cleanString((frame as any).lastAction) ??
    "直前の文脈";

  return {
    askType: "reference_followup",
    currentQuestion: cleanString(userText) ?? "",
    referenceTarget,
    mainSubject,
    sourcePhrase: options?.sourcePhrase ?? "active_context_frame",
    sourceUserText: cleanString(userText) ?? "",
    sourceAssistantText: referenceTarget,
    sourcePreviousUserText: "",
    readingMode: "active_context_reference",
    askFrame: `${mainSubject}を正本として、現在の質問に答える`,
    scope: "current_turn",
    expiresAfterTurn: true,
    confidence: options?.confidence ?? 1,
  };
}

export function buildDiagnosisFollowupSeedFromFrame(
  frame: ActiveContextFrame | null | undefined,
  userText: unknown
): string | null {
  if (!frame) return null;

  const primary = getPrimaryEntity(frame);
  if (!primary || primary.kind !== "diagnosis") return null;

  const diagnosisText = cleanString(primary.sourceText);
  if (!diagnosisText) return null;

  const meta = asObject(primary.meta) ?? {};
  const diagnosisType = cleanString(meta.diagnosisType);
  const source = cleanString(meta.source) ?? cleanString(meta.sourceTable);
  const displayId = cleanString(meta.displayId);
  const targetLabel = cleanString(meta.targetLabel);
  const targetKey = cleanString(meta.targetKey);
  const relationId = cleanString(meta.relationId);

  if (diagnosisType === "screenshot") {
    return [
      "SCREENSHOT_DIAGNOSIS_FOLLOWUP_SEED (DO NOT OUTPUT):",
      "source=mu_screenshot_diagnosis_logs",
      "diagnosisType=screenshot",
      "displayId=" + String(displayId ?? ""),
      "targetLabel=" + String(targetLabel ?? ""),
      "targetKey=" + String(targetKey ?? ""),
      "relationId=" + String(relationId ?? ""),
      "userText=" + String(cleanString(userText) ?? ""),
      "rule=このターンは保存済みスクショ診断の続き相談。直前assistant返答ではなく、このdiagnosisTextを正本にする。",
      "writerRule=diagnosisText内の具体語を必ず使い、一般的なスクショ診断説明で返さない。",
      "diagnosisText:",
      diagnosisText,
    ].join("\n");
  }

  return [
    "DIAGNOSIS_CONTEXT_CONTROL (DO NOT OUTPUT):",
    "status=FOUND",
    "source=" + String(source ?? "activeContextFrame"),
    "diagnosisType=" + String(diagnosisType ?? "ir"),
    "targetLabel=" + String(targetLabel ?? ""),
    "targetKey=" + String(targetKey ?? ""),
    "relationId=" + String(relationId ?? ""),
    "userText=" + String(cleanString(userText) ?? ""),
    "rule=このターンは保存済み診断の続き相談。USER_TEXT単体ではなく、このdiagnosisTextを正本にする。",
    "diagnosisText:",
    diagnosisText,
  ].join("\n");
}
