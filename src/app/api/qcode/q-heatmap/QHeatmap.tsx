'use client'
import useSWR from 'swr'

type Row = { day: string; counts: Record<'Q1'|'Q2'|'Q3'|'Q4'|'Q5', number>; total: number; repQ: string }
const fetcher = (url: string) => fetch(url).then(r => r.json())

export default function QHeatmap({ user }: { user: string }) {
  const { data } = useSWR<{ user:string; data: Row[] }>(`/api/q-daily?user=${encodeURIComponent(user)}`, fetcher)
  if (!data) return <div>loading…</div>

  return (
    <div style={{ display:'grid', gap:8 }}>
      {data.data.map(d => (
        <div key={d.day} style={{ display:'grid', gridTemplateColumns:'100px 1fr 60px', gap:8, alignItems:'center' }}>
          <div style={{ opacity:.7 }}>{d.day}</div>
          <div style={{ display:'flex', gap:6 }}>
            {(['Q1','Q2','Q3','Q4','Q5'] as const).map(q => (
              <div key={q} title={`${q}: ${d.counts[q]}`}
                   style={{
                     width: 32, height: 32, borderRadius: 6,
                     background: d.counts[q] ? '#7aa3' : '#ccc2',
                     outline: d.repQ === q ? '2px solid #333' : 'none'
                   }} />
            ))}
          </div>
          <div style={{ textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{d.total}</div>
        </div>
      ))}
    </div>
  )
}
