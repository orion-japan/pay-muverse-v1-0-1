// client-only：ブラウザから /api/telemetry に投げる薄いラッパ
export type ClientTelemetry = {
  kind: 'page' | 'event' | 'auth';
  path: string;
  status?: number;
  note?: string;
  meta?: Record<string, any>;
  session_id?: string | null; // localStorage などで管理していれば渡す
};

export async function logClientEvent(p: ClientTelemetry) {
  try {
    await fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...p,
        ua: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      }),
      keepalive: true, // ページ遷移・タブ閉じでも送られやすい
    });
  } catch {
    // 失敗してもアプリ本体は落とさない
  }
}
