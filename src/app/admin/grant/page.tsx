'use client';
import { useState } from 'react';
export default function GrantPage(){
  const [user, setUser] = useState('669933');
  const [amt, setAmt] = useState(100);
  const [log, setLog] = useState<any>(null);
  return (
    <main style={{maxWidth:600,margin:'24px auto',fontFamily:'system-ui'}}>
      <h1>Grant Credit</h1>
      <input value={user} onChange={e=>setUser(e.target.value)} placeholder="user_code" />
      <input type="number" value={amt} onChange={e=>setAmt(Number(e.target.value))} />
      <button onClick={async()=>{
        const r = await fetch('/api/credits/grant', { method:'POST', headers:{'content-type':'application/json'},
          body: JSON.stringify({ user_code:user, amount: amt }) });
        setLog(await r.json());
      }}>付与</button>
      <pre style={{background:'#f5f5f5',padding:12,marginTop:16}}>{JSON.stringify(log,null,2)}</pre>
    </main>
  );
}
