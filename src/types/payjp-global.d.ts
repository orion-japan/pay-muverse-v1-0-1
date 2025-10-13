// src/types/payjp-global.d.ts
export {};

declare global {
  type PayjpTokenResult = { id?: string; error?: { message?: string } };

  interface PayjpElements {
    create(type: 'card'): any;
  }

  interface PayjpInstance {
    elements(): PayjpElements;
    createToken(element: any, opts?: { email?: string }): Promise<PayjpTokenResult>;
  }

  // CDN で提供されるグローバル関数
  function Payjp(publicKey: string): PayjpInstance;

  interface Window {
    Payjp: typeof Payjp;
  }
}
