// src/app/403/page.tsx
export default function Forbidden() {
    return (
      <main style={{maxWidth:720, margin:'40px auto', padding:'0 16px'}}>
        <h1 style={{fontSize:22, marginBottom:12}}>この機能にはアクセスできません</h1>
        <p>このページは「master / admin」プランの方のみご利用いただけます。</p>
      </main>
    );
  }
  