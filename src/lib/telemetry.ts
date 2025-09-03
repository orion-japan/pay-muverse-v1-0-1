let _sessionId: string | null = null;

export function ensureSessionId(): string {
  if (_sessionId) return _sessionId;
  _sessionId = sessionStorage.getItem('telemetry_session_id') || crypto.randomUUID();
  sessionStorage.setItem('telemetry_session_id', _sessionId);
  return _sessionId;
}

type Ev = {
  kind: string;
  path?: string;
  status?: number;
  latency_ms?: number;
  note?: string;
  meta?: Record<string, any>;
  created_at?: string;
};

export function sendTelemetry(events: Ev[] | Ev, opts?: {
  uid?: string|null;
  user_code?: string|null;
  app_ver?: string|null;
  useBeacon?: boolean;    // 既定 true
}) {
  try {
    const session_id = ensureSessionId();
    const payload = {
      session_id,
      uid: opts?.uid ?? null,
      user_code: opts?.user_code ?? null,
      ua: navigator.userAgent,
      app_ver: opts?.app_ver ?? null,
      events: Array.isArray(events) ? events : [events],
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = '/api/trace';

    // 離脱時も送れるよう sendBeacon 優先
    if (opts?.useBeacon !== false && 'sendBeacon' in navigator) {
      navigator.sendBeacon(url, blob);
    } else {
      fetch(url, { method: 'POST', body: blob, keepalive: true });
    }
  } catch {
    /* no-op */
  }
}

// 心拍（ハートビート）
let hbTimer: any = null;
export function startHeartbeat(intervalMs = 30000, baseMeta?: Record<string, any>) {
  stopHeartbeat();
  const tick = () => {
    sendTelemetry({ kind: 'heartbeat', note: 'alive', meta: baseMeta });
    hbTimer = setTimeout(tick, intervalMs);
  };
  tick();
}
export function stopHeartbeat() { if (hbTimer) clearTimeout(hbTimer); hbTimer = null; }

// オンライン/オフライン
export function wireOnlineOffline() {
  const on = () => sendTelemetry({ kind: 'online' });
  const off = () => sendTelemetry({ kind: 'offline' });
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
}

// ページ表示
export function tracePage(path: string) {
  sendTelemetry({ kind: 'page', path });
}
