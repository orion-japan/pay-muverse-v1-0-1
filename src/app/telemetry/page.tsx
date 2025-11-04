// src/app/telemetry/page.tsx
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

type Search = {
  hours?: string;
  kind?: string;
  path?: string;
  limit?: string;
  view?: 'events' | 'sessions';
};

// ========== Supabase helpers ==========
function sbAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!; // ← server only
  return createClient(url, key, { auth: { persistSession: false } });
}

// ========== EVENTS (既存) ==========
async function fetchEvents(searchParams: Search) {
  const sb = sbAdmin();

  const hours = numBetween(Number(searchParams.hours ?? 24), 1, 168);
  const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString();
  const limit = numBetween(Number(searchParams.limit ?? 200), 50, 1000);

  let q = sb
    .from('telemetry_event')
    .select(
      `id, created_at, kind, path, status, latency_ms, note, session_id,
             telemetry_session:telemetry_session (uid,user_code,ua)`,
    )
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit);

  const kind = (searchParams.kind || '').trim();
  const path = (searchParams.path || '').trim();
  if (kind) q = q.eq('kind', kind);
  if (path) q = q.ilike('path', `%${path}%`);

  const { data } = await q;
  return { rows: data ?? [], hours, limit, kind, path };
}

// ========== SESSIONS（追加：落ちた時間＆理由） ==========
type SessionRow = {
  session_id: string;
  uid: string | null;
  user_code: string | null;
  ua: string | null;
  app_ver: string | null;
  started_at: string; // ISO
  last_seen: string; // ISO
};

type LastEvent = {
  session_id: string;
  created_at: string;
  kind: string | null;
  path: string | null;
  status: number | null;
  note: string | null;
};

async function fetchSessions(searchParams: Search) {
  const sb = sbAdmin();

  const hours = numBetween(Number(searchParams.hours ?? 24), 1, 168);
  const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString();

  // 1) 対象期間のセッション
  const { data: sessionsRaw } = await sb
    .from('telemetry_session')
    .select('session_id, uid, user_code, ua, app_ver, started_at, last_seen')
    .gte('started_at', sinceIso)
    .order('last_seen', { ascending: false });

  const sessions: SessionRow[] = (sessionsRaw ?? []) as any[];
  const ids = sessions.map((s) => s.session_id);
  if (ids.length === 0) return { rows: [] as any[], hours };

  // 2) 各セッションの「最後のイベント」
  const { data: eventsRaw } = await sb
    .from('telemetry_event')
    .select('session_id, created_at, kind, path, status, note')
    .in('session_id', ids)
    .order('created_at', { ascending: false });

  const lastBySession = new Map<string, LastEvent>();
  for (const ev of eventsRaw ?? []) {
    const sid = (ev as any).session_id as string;
    if (!lastBySession.has(sid)) lastBySession.set(sid, ev as any); // 降順なので最初が「最後のイベント」
  }

  // 3) 推定理由を付与
  const rows = sessions.map((s) => {
    const last = lastBySession.get(s.session_id) || null;
    const reason = inferReason(s, last);
    const durationMs = new Date(s.last_seen).getTime() - new Date(s.started_at).getTime();
    return {
      ...s,
      duration_min: Math.max(0, Math.round(durationMs / 60000)),
      last_event_time: last?.created_at ?? null,
      last_status: last?.status ?? null,
      last_kind: last?.kind ?? null,
      last_path: last?.path ?? null,
      last_note: last?.note ?? null,
      reason,
    };
  });

  return { rows, hours };
}

// ヘuristic: 落ちた「理由」を推定
function inferReason(s: SessionRow, last: LastEvent | null): string {
  if (!last) return '理由不明（イベントなし）';
  const status = last.status ?? 0;
  const path = (last.path || '').toLowerCase();
  const note = (last.note || '').toLowerCase();

  if (status === 401 || status === 403 || note.includes('verifyidtoken')) {
    return '認証エラー/トークン失効';
  }
  if (status === 0 || note.includes('network') || note.includes('failed to fetch')) {
    return 'ネットワーク切断/タイムアウト';
  }
  if (last.kind === 'page' && (path.includes('logout') || path.includes('/login'))) {
    return 'ユーザー操作によるログアウト/遷移';
  }
  // 直近で強制更新っぽいパターン（ページロード event で終了）
  if (last.kind === 'page' && path.startsWith('/')) {
    return 'ページ再読み込み/リロード';
  }
  return '不明';
}

// ========== PAGE ==========
export default async function TelemetryPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const view = (sp.view ?? 'events') as 'events' | 'sessions';

  const [events, sessions] = await Promise.all([
    view === 'events' ? fetchEvents(sp) : Promise.resolve(null),
    view === 'sessions' ? fetchSessions(sp) : Promise.resolve(null),
  ]);

  return (
    <div style={{ padding: 16, maxWidth: 980, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>Telemetry</h1>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <a
          href={`/telemetry?${withParam(sp, 'view', 'events')}`}
          style={tabStyle(view === 'events')}
        >
          Events
        </a>
        <a
          href={`/telemetry?${withParam(sp, 'view', 'sessions')}`}
          style={tabStyle(view === 'sessions')}
        >
          Sessions（落ちた時間）
        </a>
      </div>

      {/* Filters */}
      <form action="/telemetry" method="get" style={filtersStyle}>
        <input type="hidden" name="view" value={view} />
        <L label="Hours">
          <input
            type="number"
            name="hours"
            defaultValue={Number(sp.hours ?? 24)}
            min={1}
            max={168}
            style={inStyle}
          />
        </L>

        {view === 'events' && (
          <>
            <L label="Kind">
              <input
                name="kind"
                defaultValue={sp.kind ?? ''}
                placeholder="api / page / ..."
                style={inStyle}
              />
            </L>
            <L label="Path contains">
              <input
                name="path"
                defaultValue={sp.path ?? ''}
                placeholder="/api/visions"
                style={inStyle}
              />
            </L>
            <L label="Limit">
              <input
                type="number"
                name="limit"
                defaultValue={Number(sp.limit ?? 200)}
                min={50}
                max={1000}
                step={50}
                style={inStyle}
              />
            </L>
          </>
        )}

        <button type="submit" style={btnPrimary}>
          Apply
        </button>
      </form>

      {view === 'events' && events && <EventsTable {...events} />}
      {view === 'sessions' && sessions && <SessionsTable {...sessions} />}
    </div>
  );
}

// ========== UI bits ==========
function EventsTable({ rows, hours }: any) {
  return (
    <>
      <div style={{ marginBottom: 8, color: '#666' }}>
        Showing <b>{rows.length}</b> events (last <b>{hours}</b>h)
      </div>
      <div style={tableWrap}>
        <table style={tableStyle}>
          <thead style={theadStyle}>
            <tr>
              {[
                'time',
                'kind',
                'status',
                'lat(ms)',
                'path',
                'uid',
                'user_code',
                'ua',
                'session',
              ].map((h, i) => (
                <th key={i} style={{ ...thStyle, textAlign: i <= 3 ? 'center' : 'left' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={9} />}
            {rows.map((r: any) => (
              <tr key={r.id}>
                <td style={td}>{fmt(r.created_at)}</td>
                <td style={td}>{r.kind}</td>
                <td style={{ ...td, textAlign: 'center' }}>{r.status ?? ''}</td>
                <td style={{ ...td, textAlign: 'center' }}>{r.latency_ms ?? ''}</td>
                <td
                  style={{
                    ...td,
                    maxWidth: 420,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.path ?? ''}
                </td>
                <td style={td}>{r.telemetry_session?.uid ?? ''}</td>
                <td style={td}>{r.telemetry_session?.user_code ?? ''}</td>
                <td
                  style={{
                    ...td,
                    maxWidth: 460,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.telemetry_session?.ua ?? ''}
                </td>
                <td style={{ ...td, fontFamily: 'monospace' }}>{r.session_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SessionsTable({ rows, hours }: any) {
  return (
    <>
      <div style={{ marginBottom: 8, color: '#666' }}>
        Showing <b>{rows.length}</b> sessions (last <b>{hours}</b>h)
      </div>
      <div style={tableWrap}>
        <table style={tableStyle}>
          <thead style={theadStyle}>
            <tr>
              {[
                'last_seen（落ちた時刻）',
                '理由(推定)',
                'status',
                'path(最後)',
                'uid',
                'user_code',
                'ua',
                'duration(min)',
                'started_at',
                'session',
              ].map((h, i) => (
                <th key={i} style={{ ...thStyle, textAlign: i <= 2 ? 'center' : 'left' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={10} />}
            {rows.map((r: any) => (
              <tr key={r.session_id}>
                <td style={td}>{fmt(r.last_seen)}</td>
                <td style={{ ...td, fontWeight: 600 }}>{r.reason}</td>
                <td style={{ ...td, textAlign: 'center' }}>{r.last_status ?? ''}</td>
                <td
                  style={{
                    ...td,
                    maxWidth: 420,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.last_path ?? ''}
                </td>
                <td style={td}>{r.uid ?? ''}</td>
                <td style={td}>{r.user_code ?? ''}</td>
                <td
                  style={{
                    ...td,
                    maxWidth: 420,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.ua ?? ''}
                </td>
                <td style={{ ...td, textAlign: 'center' }}>{r.duration_min}</td>
                <td style={td}>{fmt(r.started_at)}</td>
                <td style={{ ...td, fontFamily: 'monospace' }}>{r.session_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function EmptyRow({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: 24, textAlign: 'center', color: '#888' }}>
        No data.
      </td>
    </tr>
  );
}

// ========== small utils/styles ==========
const inStyle: React.CSSProperties = { padding: 8, borderRadius: 8, border: '1px solid #ccc' };
const btnPrimary: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid #999',
  background: '#111',
  color: '#fff',
  fontWeight: 600,
};
const filtersStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
  gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))',
  alignItems: 'end',
  marginBottom: 12,
};
const tableWrap: React.CSSProperties = {
  overflowX: 'auto',
  border: '1px solid #eee',
  borderRadius: 12,
};
const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'separate',
  borderSpacing: 0,
  fontSize: 13,
};
const theadStyle: React.CSSProperties = { background: '#fafafa' };
const thStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid #eee',
  position: 'sticky',
  top: 0,
  background: '#fafafa',
  textAlign: 'left',
};
const td: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid #f0f0f0',
  verticalAlign: 'top',
};

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span>{label}</span>
      {children}
    </label>
  );
}
function fmt(s: string) {
  return new Date(s).toLocaleString();
}
function numBetween(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}
function withParam(sp: Record<string, any>, key: string, val: string) {
  const q = new URLSearchParams(sp as any);
  q.set(key, val);
  return q.toString();
}
function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '8px 12px',
    borderRadius: 10,
    border: '1px solid #ddd',
    background: active ? '#111' : '#fafafa',
    color: active ? '#fff' : '#333',
    fontWeight: 600,
    textDecoration: 'none',
  };
}
