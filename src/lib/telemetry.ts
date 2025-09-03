// src/lib/telemetry.ts
// 収集API: /api/telemetry/collect へ送るだけの最小実装

export type TLog = {
    kind?: 'api' | 'page' | 'auth' | 'online';
    path?: string;
    status?: number | null;
    latency_ms?: number | null;
    note?: string;
    uid?: string | null;
    user_code?: string | null;
  };
  
  export function tlog(p: TLog) {
    try {
      const payload = JSON.stringify(p || {});
      if (navigator.sendBeacon) {
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/telemetry/collect', blob);
      } else {
        fetch('/api/telemetry/collect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {}
  }
  
  /** セッションIDをローカルに確保（存在しなければ生成） */
  export function ensureSessionId(key = 'telemetry_session_id'): string {
    let id = '';
    try {
      id = localStorage.getItem(key) || '';
      if (!id) {
        id = (crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
        localStorage.setItem(key, id);
        // 参考: セッション開始をイベントにも一応残す
        tlog({ kind: 'online', path: 'session_start', note: id });
      }
    } catch {
      // localStorage 不可でもビルドは通す
      id = (crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
    }
    return id;
  }
  
  /** online/offline の変化を監視して記録（解除関数を返す） */
  export function wireOnlineOffline() {
    const on = () => tlog({ kind: 'online', path: 'online', note: 'online' });
    const off = () => tlog({ kind: 'online', path: 'offline', note: 'offline' });
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }
  
  /** ハートビート（一定間隔で生存記録） */
  declare global {
    interface Window { __mu_hb?: number }
  }
  export function startHeartbeat(ms = 60_000) {
    stopHeartbeat();
    window.__mu_hb = window.setInterval(() => {
      tlog({
        kind: 'online',
        path: 'heartbeat',
        note: navigator.onLine ? 'online' : 'offline',
      });
    }, Math.max(5_000, ms)); // 最小5秒
  }
  export function stopHeartbeat() {
    if (window.__mu_hb) {
      clearInterval(window.__mu_hb);
      window.__mu_hb = undefined;
    }
  }
  
  /** ページ表示の痕跡を軽く残す（計測が無くてもOK） */
  export function tracePage(path?: string, note?: string) {
    try {
      const p = path || location.pathname;
      tlog({ kind: 'page', path: p, note });
    } catch {
      // 何もしない
    }
  }
  