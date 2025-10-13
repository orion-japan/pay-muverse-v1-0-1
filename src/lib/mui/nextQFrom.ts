// src/lib/mui/nextQFrom.ts

export type Q = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export function nextQFrom(current: Q): Q {
  const order: Q[] = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];
  const i = order.indexOf(current);
  return order[(i + 1 + order.length) % order.length];
}

export default nextQFrom;
