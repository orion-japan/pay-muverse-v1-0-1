// global.d.ts
interface Grecaptcha {
  ready(cb: () => void): void
  render: (...args: any[]) => any
  // 必要なら他メソッドも追記
}

interface Window {
  grecaptcha: Grecaptcha
  confirmationResult: any
}
