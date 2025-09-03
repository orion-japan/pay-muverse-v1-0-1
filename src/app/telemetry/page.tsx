// src/app/telemetry/page.tsx
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

type Search = { hours?: string; kind?: string; path?: string; limit?: string };

async function fetchEvents(searchParams: Search) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const hours = Math.min(Math.max(Number(searchParams.hours ?? 24), 1), 168);
  const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString();
  const limit = Math.min(Math.max(Number(searchParams.limit ?? 200), 50), 1000);

  let q = sb
    .from('telemetry_event')
    .select(`id, created_at, kind, path, status, latency_ms, note, session_id,
             telemetry_session:telemetry_session (uid,user_code,ua)`)
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

export default async function TelemetryPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const { rows, hours, limit, kind, path } = await fetchEvents(sp);

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>
        Telemetry / Events
      </h1>

      <form
        action="/telemetry"
        method="get"
        style={{
          display: 'grid',
          gap: 8,
          gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))',
          alignItems: 'end',
          marginBottom: 12,
        }}
      >
        <label style={{ display: 'grid', gap: 4 }}>
          <span>Hours</span>
          <input
            type="number"
            name="hours"
            defaultValue={hours}
            min={1}
            max={168}
            style={inStyle}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span>Kind</span>
          <input
            name="kind"
            defaultValue={kind}
            placeholder="api / page / ..."
            style={inStyle}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span>Path contains</span>
          <input
            name="path"
            defaultValue={path}
            placeholder="/api/get-user-info"
            style={inStyle}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span>Limit</span>
          <input
            type="number"
            name="limit"
            defaultValue={limit}
            min={50}
            max={1000}
            step={50}
            style={inStyle}
          />
        </label>
        <button type="submit" style={btnPrimary}>
          Apply
        </button>
      </form>

      <div style={{ marginBottom: 8, color: '#666' }}>
        Showing <b>{rows.length}</b> events (last <b>{hours}</b>h)
      </div>

      <div
        style={{
          overflowX: 'auto',
          border: '1px solid #eee',
          borderRadius: 12,
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'separate',
            borderSpacing: 0,
            fontSize: 13,
          }}
        >
          <thead style={{ background: '#fafafa' }}>
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
                <th
                  key={i}
                  style={{
                    textAlign: i <= 3 ? 'center' : 'left',
                    padding: '10px 12px',
                    borderBottom: '1px solid #eee',
                    position: 'sticky',
                    top: 0,
                    background: '#fafafa',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  style={{
                    padding: 24,
                    textAlign: 'center',
                    color: '#888',
                  }}
                >
                  No events yet.
                </td>
              </tr>
            )}
            {rows.map((r: any) => (
              <tr key={r.id}>
                <td style={td}>{new Date(r.created_at).toLocaleString()}</td>
                <td style={td}>{r.kind}</td>
                <td style={{ ...td, textAlign: 'center' }}>
                  {r.status ?? ''}
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  {r.latency_ms ?? ''}
                </td>
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
                <td style={{ ...td, fontFamily: 'monospace' }}>
                  {r.session_id}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const inStyle: React.CSSProperties = {
  padding: 8,
  borderRadius: 8,
  border: '1px solid #ccc',
};
const btnPrimary: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid #999',
  background: '#111',
  color: '#fff',
  fontWeight: 600,
};
const td: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid #f0f0f0',
  verticalAlign: 'top',
};
