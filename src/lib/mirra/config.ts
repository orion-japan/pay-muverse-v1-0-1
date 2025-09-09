export const MIRRA_AGENT = 'mirra' as const;

export const MIRRA_CONFIG = {
  agent: MIRRA_AGENT,
  COST_PER_TURN: 1.0,   // 1往復=1クレジット
  numLabels: 3,
  numSteps: 3,
} as const;
