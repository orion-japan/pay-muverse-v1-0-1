'use client';
import { useEffect, useState } from 'react';

type Item = { created_at:string; user_code:string; amount:number; kind:string; ref:string; balance_after:number; };

export default function LedgerPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [err, setErr] = useState<string|undefined>();

  useEffect(() => {
    fetch('/api/admin/ledger', { cache:'no-store' })
      .then(r=>r.json())
      .then(j=> j.ok ? setItems(j.items) : setErr(j.error || 'failed'))
      .catch(e=> setErr(String(e)));
  }, []);

  return (
    <main style={{fontFamily:'system-ui'}}>
      <h1>Credits Ledger (最新50件)</h1>
      {err && <div style={{color:'crimson'}}>{err}</div>}
      <table style={{width:'100%', borderCollapse:'collapse'}}>
        <thead>
          <tr><th>Time</th><th>User</th><th>Kind</th><th style={{textAlign:'right'}}>Amount</th><th>Ref</th><th style={{textAlign:'right'}}>Balance</th></tr>
        </thead>
        <tbody>
          {items.map((x,i)=>(
            <tr key={i} style={{borderTop:'1px solid #eee'}}>
              <td>{new Date(x.created_at).toLocaleString()}</td>
              <td>{x.user_code}</td>
              <td>{x.kind}</td>
              <td style={{textAlign:'right'}}>{x.amount}</td>
              <td><code>{x.ref}</code></td>
              <td style={{textAlign:'right'}}>{x.balance_after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
