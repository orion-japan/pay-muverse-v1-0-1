// src/lib/constants/planIdMap.ts
// src/lib/constants/planIdMap.ts

export const PLAN_ID_MAP: Record<string, string> = {
  master: process.env.PLAN_ID_MASTER!,
  premium: process.env.PLAN_ID_PREMIUM!,
  regular: process.env.PLAN_ID_REGULAR!,
};
