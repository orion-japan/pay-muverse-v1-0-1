'use client';
import Link from 'next/link';
// import AdminGate from '@/components/AdminGate';  ← 一旦外す

export default function AdminHome() {
  const cards = [
    { href:'/logs', title:'Logs', desc:'ログメニュー（テレメトリ・登録ログ）' },
    { href:'/ai-q-dashboard', title:'AI Q Dashboard', desc:'AI処理のメトリクス（雛形）' },
    { href:'/qcode', title:'QCode 管理', desc:'ユーザーコードと権限（雛形）' },
    { href:'/admin/delete-user', title:'ユーザー削除', desc:'Firebase + Supabase のユーザー削除（管理者用）' },
    { href:'/admin/leaders', title:'リーダー管理', desc:'リーダー昇格とティア履歴の管理' },
    { href:'/admin/promotions', title:'プロモーション設定', desc:'クレジット倍増・期限付きイベントの設定' }, // ★ 追加
    { href:'/admin/events', title:'イベント管理', desc:'イベント用グループ作成＋招待発行' },
    { href:'/admin/credits', title:'クレジット調整', desc:'返金/プロモ付与/履歴' },

  ];

  return (
    // <AdminGate>  ← ラップも外す
    <div style={{padding:16}}>
      <h1 style={{fontSize:22,fontWeight:700,marginBottom:12}}>Admin Dashboard</h1>
      <div style={{
        display:'grid',
        gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',
        gap:12
      }}>
        {cards.map(c=>(
          <Link key={c.href} href={c.href} style={{
            display:'block',
            padding:'14px',
            border:'1px solid #e5e5e5',
            borderRadius:12,
            textDecoration:'none',
            color:'#111'
          }}>
            <div style={{fontWeight:700, marginBottom:6}}>{c.title}</div>
            <div style={{color:'#666', fontSize:13}}>{c.desc}</div>
          </Link>
        ))}
      </div>
    </div>
    // </AdminGate>
  );
}
