// src/types/global.d.ts
export {};

declare global {
  interface Window {
    /** Pay.jp のグローバル。optional にしない（他所と不一致を避ける） */
    Payjp: any;

    /** 使っているなら補助キャッシュ */
    __payjpInstance?: any;
    __payjpElements?: {
      cardNumber?: any;
      cardExpiry?: any;
      cardCvc?: any;
    };
  }
}
