export type QCodePayload = {
    q?: string | null;        // 例: "Q3"
    stage?: string | null;    // 例: "S2"
    meta?: Record<string, any>;
  };
  
  export function buildQCode({ q, stage, meta }: QCodePayload) {
    return {
      ts: Math.floor(Date.now() / 1000),
      currentQ: q ?? null,
      depthStage: stage ?? null,
      ...(meta ? { meta } : {}),
    };
  }
  