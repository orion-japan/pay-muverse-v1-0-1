// GUI用の最小スタブ。既存があれば不要。
let __session = '';
export function ensureSessionId() {
  if (!__session) __session = crypto?.randomUUID?.() ?? String(Date.now());
  return __session;
}
let hbTimer: any = null;
export function startHeartbeat(ms = 30000) {
  if (hbTimer) clearInterval(hbTimer);
  hbTimer = setInterval(() => {
    // ここで /api/telemetry などへ送るならfetch
    // console.log('[HB]', new Date().toISOString());
  }, ms);
}
export function stopHeartbeat() {
  if (hbTimer) clearInterval(hbTimer);
  hbTimer = null;
}
export function wireOnlineOffline() {
  const on = () => {/* console.log('online') */};
  const off = () => {/* console.log('offline') */};
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  return () => {
    window.removeEventListener('online', on);
    window.removeEventListener('offline', off);
  };
}
export function tracePage(path: string) {
  // 本番はGA/自前APIに送信
  // console.log('[TRACE]', path);
}
export function tlog(entry: { kind: string; path?: string; note?: string }) {
  // 本番はサーバへ。いまはコンソール。
  // console.log('[TLOG]', entry);
}
