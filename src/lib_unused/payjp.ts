// src/lib/payjp.ts
// @ts-ignore
import Payjp from '@payjp/browser';

// もしくは型を any に
export const getPayjp = () => {
  return Payjp(process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY!) as any;
};
