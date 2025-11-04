// global.d.ts

// ✅ Grecaptcha 用
interface Grecaptcha {
  ready(cb: () => void): void;
  render: (...args: any[]) => any;
  // 必要なら他メソッドも追記
}

interface Window {
  grecaptcha: Grecaptcha;
  confirmationResult: any;
}

// ✅ PAY.JP の型解決エラーを止める
declare module 'payjp';
