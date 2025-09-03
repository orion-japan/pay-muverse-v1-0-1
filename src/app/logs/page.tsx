// src/app/logs/page.tsx
'use client';
import Link from 'next/link';

export default function LogsHome() {
  return (
    <main style={{padding:16}}>
      <h1 style={{fontSize:22,fontWeight:700,marginBottom:12}}>Logs</h1>
      <ul style={{lineHeight:1.9}}>
        <li><Link href="/telemetry">📈 Telemetry（API / Page / Online）</Link></li>
        <li><Link href="/admin/register-logs">🧾 ユーザー登録ログ</Link></li>
      </ul>
      <p style={{marginTop:12,color:'#777'}}>※ 以前 /logs にあった登録ログは <b>/admin/register-logs</b> に移動しました。</p>
    </main>
  );
}
