export const PRICES = {
    stage2: 280,
    stage3: 980,
    stage4: 1980,
  } as const;
  export type StageKey = keyof typeof PRICES;
  