'use client';

import { useState } from 'react';

export default function CreditsTestPage() {
  const [user_code, setUser] = useState('669933');
  const [amount, setAmount] = useState(5);
  const [ref, setRef] = useState(() => crypto.randomUUID());
  const [log, setLog] = useState<any>(null);

  async function post(path: string, body: any) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    setLog(j);
  }

  return (
    <main style={{maxWidth:680, margin:'32px auto', fontFamily:'system-ui'}}>
      <h1>Credits Test (GUI)</h1>
      <label>user_code: <input value={user_code} onChange={e=>setUser(e.target.value)} /></label><br/>
      <label>amount: <input type="number" value={amount} onChange={e=>setAmount(Number(e.target.value))} /></label><br/>
      <label>ref: <input value={ref} onChange={e=>setRef(e.target.value)} /></label><br/>
      <div style={{display:'flex', gap:8, marginTop:12}}>
        <button onClick={()=>post('/api/credits/authorize', { user_code, amount, ref, ref_conv:'conv_demo' })}>Authorize</button>
        <button onClick={()=>post('/api/credits/capture', { user_code, amount, ref })}>Capture</button>
        <button onClick={()=>setRef(crypto.randomUUID())}>New Ref</button>
      </div>
      <pre style={{background:'#f5f5f5', padding:12, marginTop:16, whiteSpace:'pre-wrap'}}>
        {JSON.stringify(log, null, 2)}
      </pre>
      <p style={{marginTop:16}}>
        先に Supabase の SQL を実行し、Vercel に <code>SUPABASE_SERVICE_ROLE_KEY</code> を設定してから試してください。
      </p>
    </main>
  );
}
